import { load } from 'cheerio';
import type { Context } from 'hono';

import type { Data, Route } from '@/types';
import { ViewType } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

interface RscBlogPost {
    slug?: string;
    href?: string;
    title?: string;
    date?: string;
    authorText?: string;
    externalPublicationName?: string;
    isExternal?: boolean;
}

const parseRscBlogPosts = (html: string): RscBlogPost[] => {
    const $ = load(html);

    // Collect RSC payload chunks from self.__next_f.push([1,"..."]) script tags
    const regexp = /self\.__next_f\.push\((.+)\)/;
    const textList: string[] = [];
    for (const el of $('script').toArray()) {
        const text = $(el).text();
        const match = regexp.exec(text);
        if (match) {
            try {
                const data = JSON.parse(match[1]);
                if (Array.isArray(data) && data.length === 2 && data[0] === 1) {
                    textList.push(data[1]);
                }
            } catch {
                // ignore
            }
        }
    }

    const combined = textList.join('');

    // Find the posts array: the BlogDirectoryClient component receives props with "posts":[{"slug":...}]
    const postsKey = '"posts":[{"slug"';
    const postsKeyIdx = combined.indexOf(postsKey);
    if (postsKeyIdx === -1) {
        return [];
    }

    // Extract the balanced JSON array starting at the '[' after "posts":
    const arrayStart = postsKeyIdx + '"posts":'.length;
    let depth = 0;
    let inString = false;
    let i = arrayStart;

    while (i < combined.length) {
        const ch = combined[i];
        if (inString) {
            if (ch === '\\') {
                i += 2; // skip escaped character
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
        } else {
            switch (ch) {
                case '"':
                    inString = true;
                    break;
                case '[':
                case '{':
                    depth++;
                    break;
                case ']':
                case '}':
                    depth--;
                    if (depth === 0) {
                        break;
                    }
                    break;
                default:
                    break;
            }

            if (depth === 0 && (ch === ']' || ch === '}')) {
                break;
            }
        }
        i++;
    }

    try {
        return JSON.parse(combined.slice(arrayStart, i + 1)) as RscBlogPost[];
    } catch {
        return [];
    }
};

type ListItem = {
    title: string;
    description: string;
    pubDate: Date | undefined;
    link: string | undefined;
    author?: string;
    isExternal: boolean;
};

const parseDomBlogPosts = (html: string, baseUrl: string, limit: number): ListItem[] => {
    const $ = load(html);

    return $('#main')
        .last()
        .find('article')
        .toArray()
        .flatMap((article) => {
            const $article = $(article);
            const $link = $article.parent('a').length > 0 ? $article.parent('a').first() : $article.find('a').first();

            if ($link.length === 0) {
                return [];
            }

            const href = $link.attr('href');
            if (!href || href === '/blog' || href.startsWith('/blog/topic/')) {
                return [];
            }

            const title =
                $article
                    .find('p')
                    .toArray()
                    .map((p) => $(p).text().trim())
                    .find(Boolean) ?? '';

            if (!title) {
                return [];
            }

            const pubDate = parseDate($article.find('time').first().attr('datetime') ?? $article.find('time').first().attr('dateTime'));
            if (!pubDate) {
                return [];
            }

            const isExternal = !href.startsWith('/') && !href.startsWith(baseUrl);

            return [
                {
                    title,
                    description: '',
                    pubDate,
                    link: new URL(href, baseUrl).href,
                    isExternal,
                },
            ];
        })
        .slice(0, limit);
};

export const handler = async (ctx: Context): Promise<Data> => {
    const { topic } = ctx.req.param();
    const limit: number = Number.parseInt(ctx.req.query('limit') ?? '10', 10);

    const baseUrl = 'https://cursor.com';
    const path = topic ? `/blog/topic/${topic}` : '/blog';
    const targetUrl = new URL(path, baseUrl).href;

    const html = await ofetch(targetUrl, {
        headers: {
            cookie: 'NEXT_LOCALE=en',
        },
    });
    const $ = load(html);

    const rscPosts = parseRscBlogPosts(html)
        .filter((post) => topic || !post.isExternal)
        .slice(0, limit);
    const listItems: ListItem[] =
        rscPosts.length > 0
            ? rscPosts.map((post) => {
                  const href = post.href;
                  const isExternal = !href || (!href.startsWith('/') && !href.startsWith(baseUrl));
                  const link = href ? new URL(href, baseUrl).href : undefined;
                  return {
                      title: post.title ?? '',
                      description: '',
                      pubDate: post.date ? parseDate(post.date) : undefined,
                      link,
                      isExternal,
                      author: isExternal ? post.externalPublicationName : post.authorText,
                  };
              })
            : parseDomBlogPosts(html, baseUrl, limit);

    const items = await Promise.all(
        listItems.map(async ({ isExternal, ...item }) => {
            if (isExternal || !item.link) {
                return item;
            }

            return await cache.tryGet(item.link, async () => {
                const articleHtml = await ofetch(item.link!, {
                    headers: {
                        cookie: 'NEXT_LOCALE=en',
                    },
                });
                const $article = load(articleHtml);

                const fullContent = $article('.prose.prose--blog').html();
                if (fullContent) {
                    item.description = fullContent;
                }

                // Extract author from JSON-LD BlogPosting structured data (only if not already set)
                if (!item.author) {
                    const jsonLdScript = $article('script[type="application/ld+json"]')
                        .toArray()
                        .map((el) => {
                            try {
                                return JSON.parse($article(el).html() ?? '');
                            } catch {
                                return null;
                            }
                        })
                        .find((data) => data && data['@type'] === 'BlogPosting');

                    if (jsonLdScript?.author) {
                        const author = Array.isArray(jsonLdScript.author)
                            ? jsonLdScript.author
                                  .map((a: { name?: string }) => a.name)
                                  .filter(Boolean)
                                  .join(', ')
                            : jsonLdScript.author.name;
                        if (author) {
                            item.author = author;
                        }
                    }
                }

                return item;
            });
        })
    );

    return {
        title: $('title').text() || 'Cursor Blog',
        description: $('meta[property="og:description"]').attr('content'),
        link: targetUrl,
        item: items,
        allowEmpty: true,
        image: $('meta[property="og:image"]').attr('content'),
    };
};

export const route: Route = {
    path: '/blog/:topic?',
    name: 'Blog',
    url: 'cursor.com',
    maintainers: ['johan456789'],
    example: '/cursor/blog',
    parameters: {
        topic: 'Optional topic: product | research | company | ideas | customers | press',
    },
    description: undefined,
    categories: ['blog'],
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportRadar: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['cursor.com/blog', 'cursor.com/blog/topic/:topic'],
            target: '/blog/:topic',
        },
    ],
    view: ViewType.Articles,
    handler,
};
