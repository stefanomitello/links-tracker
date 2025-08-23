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

type Bindings = {
	DB: D1Database;
	ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// API routes
app.post('/api/links', async (c) => {
	try {
		const { slug, url } = await c.req.json();
		if (!slug || !url) {
			return c.json({ error: 'Slug and URL are required' }, 400);
		}
		await c.env.DB.prepare('INSERT INTO links (slug, url) VALUES (?, ?)').bind(slug, url).run();
		return c.json({ message: 'Link created successfully' });
	} catch (e: any) {
		console.error({ message: e.message });
		return c.json({ error: 'Something went wrong' }, 500);
	}
});

app.delete('/api/links', async (c) => {
	try {
		const { slug } = await c.req.json();
		if (!slug) {
			return c.json({ error: 'Slug is required' }, 400);
		}
		await c.env.DB.prepare('DELETE FROM links WHERE slug = ?').bind(slug).run();
		return c.json({ message: 'Link deleted successfully' });
	} catch (e: any) {
		console.error({ message: e.message });
		return c.json({ error: 'Something went wrong' }, 500);
	}
});

app.get('/api/links', async (c) => {
	try {
		const { results } = await c.env.DB.prepare('SELECT * FROM links').all();
		return c.json(results);
	} catch (e: any) {
		console.error({ message: e.message });
		return c.json({ error: 'Something went wrong' }, 500);
	}
});

app.get('/api/analytics/:slug', async (c) => {
	const slug = c.req.param('slug');
	try {
		const linkQuery = await c.env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first();

		if (!linkQuery) {
			return c.json({ error: 'Link not found' }, 404);
		}
		const link_id = linkQuery.id;

		const { results } = await c.env.DB.prepare('SELECT * FROM analytics WHERE link_id = ?').bind(link_id).all();
		return c.json(results);
	} catch (e: any) {
		console.error({ message: e.message });
		return c.json({ error: 'Something went wrong' }, 500);
	}
});

// Redirect route
app.get('/:slug', async (c) => {
	const slug = c.req.param('slug');

	// This is a simple way to distinguish between slugs and file paths
	if (slug.includes('.')) {
		return c.env.ASSETS.fetch(c.req.raw);
	}

	try {
		const linkQuery = await c.env.DB.prepare('SELECT id, url FROM links WHERE slug = ?').bind(slug).first();

		if (!linkQuery) {
			// If link not found, maybe it's a static asset for the dashboard
			return c.env.ASSETS.fetch(c.req.raw);
		}

		const { id: link_id, url } = linkQuery;
		const queryparams = c.req.query();
		const userdata = {
			ua: c.req.header('user-agent') || 'unknown',
			ip: c.req.header('cf-connecting-ip') || 'unknown',
			referer: c.req.header('referer') || null,
		};

		const metrics = JSON.stringify({ UTM: queryparams, headers: userdata || {} });

		try {
			await c.env.DB.prepare('INSERT INTO analytics (link_id, metrics) VALUES (?, ?)').bind(link_id, metrics).run();
		} catch (e) {
			console.error(e);
		}

		return c.redirect(url as string, 301);
	} catch (e: any) {
		console.error({ message: e.message });
		return c.json({ error: 'Something went wrong' }, 500);
	}
});

// Serve static assets for the root
app.get('/', (c) => {
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
