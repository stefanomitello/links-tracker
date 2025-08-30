/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono';

import { cors } from 'hono/cors';
import { getRouterName, showRoutes } from 'hono/dev';
import dashboardHtml from './views/main.html';
import analyticsHtml from './views/stats.html';

type Bindings = {
	DB: D1Database;
	ASSETS: Fetcher;
	BASIC_AUTH_USER: string;
	BASIC_AUTH_PASS: string;
};

const api = new Hono<{ Bindings: Bindings }>();
api.use('*', cors());
api.get('/links', async (c) => {
	try {
		const { results } = await c.env.DB.prepare('SELECT slug, url, created_at FROM links ORDER BY created_at DESC').all();
		return c.json(results);
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});
api.post('/links', async (c) => {
	try {
		const { url, slug } = await c.req.json<{ url: string; slug: string }>();
		if (!url || !slug) {
			return c.json({ error: 'URL and slug are required' }, 400);
		}
		await c.env.DB.prepare('INSERT INTO links (url, slug) VALUES (?, ?)').bind(url, slug).run();
		return c.json({ message: 'Link created successfully' }, 201);
	} catch (e: any) {
		if (e.message?.includes('UNIQUE constraint failed')) {
			return c.json({ error: 'Slug already exists' }, 409);
		}
		return c.json({ error: e.message }, 500);
	}
});
api.delete('/links', async (c) => {
	try {
		const { slug } = await c.req.json<{ slug: string }>();
		if (!slug) {
			return c.json({ error: 'Slug is required' }, 400);
		}
		await c.env.DB.prepare('DELETE FROM links WHERE slug = ?').bind(slug).run();
		return c.json({ message: 'Link deleted successfully' });
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});
api.get('/analytics/:slug', async (c) => {
	const slug = c.req.param('slug');
	try {
		const link = await c.env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first<{ id: number }>();
		if (!link) {
			return c.json({ error: 'Link not found' }, 404);
		}

		const { results } = await c.env.DB.prepare(`SELECT * FROM analytics WHERE link_id = ? ORDER BY clicked_at DESC`).bind(link.id).all();

		return c.json(results);
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api', api);
app.get('/', async (c) => {
	const authHeader = c.req.header('Authorization');
	const expected = 'Basic ' + btoa(`${c.env.BASIC_AUTH_USER}:${c.env.BASIC_AUTH_PASS}`);
	if (authHeader !== expected) {
		return c.text('Unauthorized', 401, {
			'WWW-Authenticate': 'Basic realm="Link Tracker"',
		});
	}
	return c.html(dashboardHtml);
});
app.get('/analytics', async (c) => {
	const authHeader = c.req.header('Authorization');
	const expected = 'Basic ' + btoa(`${c.env.BASIC_AUTH_USER}:${c.env.BASIC_AUTH_PASS}`);
	if (authHeader !== expected) {
		return c.text('Unauthorized', 401, {
			'WWW-Authenticate': 'Basic realm="Link Tracker"',
		});
	}
	return c.html(analyticsHtml);
});

app.get('/:slug', async (c) => {
	const slug = c.req.param('slug');

	const url = new URL(c.req.url);
	const queryParams = new URLSearchParams(url.search);

	try {
		const link = await c.env.DB.prepare('SELECT id, url FROM links WHERE slug = ?').bind(slug).first<{ id: number; url: string }>();

		if (!link) {
			return c.text('Link not found', 404);
		}

		const cf = c.req.raw.cf as any;
		const metrics = {
			ip: c.req.header('CF-Connecting-IP'),
			userAgent: c.req.header('User-Agent'),
			country: cf?.country,
			city: cf?.city,
			latitude: cf?.latitude,
			longitude: cf?.longitude,
			utm_source: queryParams.get('utm_source'),
			utm_medium: queryParams.get('utm_medium'),
			utm_campaign: queryParams.get('utm_campaign'),
		};

		c.executionCtx.waitUntil(
			c.env.DB.prepare('INSERT INTO analytics (link_id, metrics) VALUES (?, ?)').bind(link.id, JSON.stringify(metrics)).run()
		);

		const destinationUrl = new URL(link.url);
		queryParams.forEach((value, key) => {
			if (!key.startsWith('utm_')) {
				destinationUrl.searchParams.append(key, value);
			}
		});

		return c.redirect(destinationUrl.toString(), 302);
	} catch (e: any) {
		return c.text(`Error: ${e.message}`, 500);
	}
});

app.notFound((c) => c.text('404', 404));
app.onError((err, c) => c.json({ err }, 500));

console.log(getRouterName(app));
showRoutes(app, {
	verbose: true,
});

export default app;
