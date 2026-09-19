import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/components/landing/repo-url';

// SEO furniture (2026-09-19 landing-uplift): the site is two routes — the
// landing page and the workspace app. public/robots.txt (allow-all, verified)
// stays the crawl-policy source; this route just publishes the URL list.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE_URL}/app`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
  ];
}
