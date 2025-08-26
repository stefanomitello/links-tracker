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
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';

// Definizione dei tipi per l'ambiente di Cloudflare
type Bindings = {
	DB: D1Database;
	ASSETS: Fetcher;
	BASIC_AUTH_USER: string;
	BASIC_AUTH_PASS: string;
};

const protectedApp = new Hono<{ Bindings: Bindings }>();
protectedApp
	.use('*', async (c, next) => {
		const authMiddleware = basicAuth({
			username: c.env.BASIC_AUTH_USER,
			password: c.env.BASIC_AUTH_PASS,
		});
		return authMiddleware(c, next);
	})
	.use(
		'/api/*',
		cors({
			origin: (origin) => {
				return origin.endsWith('.stefanomitello.dev') ? origin : 'http://stefanomitello.dev';
			},
			allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests'],
			allowMethods: ['POST', 'GET', 'DELETE'],
			maxAge: 600,
			credentials: true,
		})
	);

protectedApp.post('/api/links', async (c) => {
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
protectedApp.delete('/api/links', async (c) => {
	try {
		const { slug } = await c.req.json<{ slug: string }>();
		if (!slug) {
			return c.json({ error: ' slug is required' }, 400);
		}
		await c.env.DB.prepare('DELETE FROM links WHERE id= ?').bind(slug).run();
		return c.json({ message: 'Link deleted successfully' }, 201);
	} catch (e: any) {
		if (e.message?.includes('UNIQUE constraint failed')) {
			return c.json({ error: 'Slug already exists' }, 409);
		}
		return c.json({ error: e.message }, 500);
	}
});
protectedApp.get('/api/links', async (c) => {
	try {
		const { results } = await c.env.DB.prepare('SELECT slug, url FROM links ORDER BY created_at DESC').all();
		return c.json(results);
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});
protectedApp.get('/api/analytics/:slug', async (c) => {
	const slug = c.req.param('slug');
	try {
		const link = await c.env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first<{ id: number }>();
		if (!link) {
			return c.json({ error: 'Link not found' }, 404);
		}

		const { results } = await c.env.DB.prepare(`SELECT metrics, clicked_at FROM analytics WHERE link_id = ? ORDER BY clicked_at DESC`)
			.bind(link.id)
			.all();

		return c.json(results);
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});
protectedApp.on('GET', ['/:slug/analitycs', '/analytics'], (c) => c.env.ASSETS.fetch(c.req.raw));

protectedApp.get('/', (c) => c.env.ASSETS.fetch(c.req.raw));

const app = new Hono<{ Bindings: Bindings }>();
app.get('/:slug', async (c) => {
	const slug = c.req.param('slug');

	if (slug.includes('.')) {
		return c.env.ASSETS.fetch(c.req.raw);
	}

	const url = new URL(c.req.url);
	const queryParams = new URLSearchParams(url.search);

	try {
		// Cerca il link nel database
		const link = await c.env.DB.prepare('SELECT id, url FROM links WHERE slug = ?').bind(slug).first<{ id: number; url: string }>();

		if (!link) {
			return c.text('Link not found', 404);
		}

		// Raccoglie i dati per l'analytics
		const cf = c.req.raw.cf as any;
		const metrics = {
			ip: c.req.header('CF-Connecting-IP'),
			userAgent: c.req.header('User-Agent'),
			country: cf?.country,
			city: cf?.city,
			latitude: cf?.latitude,
			longitude: cf?.longitude,
			utm_source: queryParams.get('utm_source') || undefined,
			utm_medium: queryParams.get('utm_medium') || undefined,
			utm_campaign: queryParams.get('utm_campaign') || undefined,
			utm_purpose: queryParams.get('utm_purpose') || undefined,
			utm_term: queryParams.get('utm_term') || undefined,
			utm_content: queryParams.get('utm_content') || undefined,
		};

		c.executionCtx.waitUntil(
			c.env.DB.prepare('INSERT INTO analytics (link_id, metrics) VALUES (?, ?)').bind(link.id, JSON.stringify(metrics)).run()
		);

		return c.redirect(link.url, 302);
	} catch (e: any) {
		return c.text(`Error: ${e.message}`, 500);
	}
});

app.route('/', protectedApp);
//app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
