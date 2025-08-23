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

// Definizione dei tipi per l'ambiente di Cloudflare
type Bindings = {
	DB: D1Database;
	ASSETS: Fetcher;
	BASIC_AUTH_USER: string;
	BASIC_AUTH_PASS: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- Rotte Pubbliche ---

// Rotta pubblica per il reindirizzamento degli short link (non richiede auth)
app.get('/:slug', async (c) => {
	const slug = c.req.param('slug');

	// Se lo slug contiene un punto, è probabile che sia un file (es. .css, .js)
	// e lo serviamo tramite ASSETS. Questo evita che la logica di redirect
	// catturi le richieste per i file statici richiesti dalle pagine HTML.
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

		// Reindirizza l'utente
		return c.redirect(link.url, 302);
	} catch (e: any) {
		return c.text(`Error: ${e.message}`, 500);
	}
});

// --- Rotte Protette ---

const protectedApp = new Hono<{ Bindings: Bindings }>();

// Middleware di autenticazione che si applica a tutte le rotte di `protectedApp`
protectedApp.use('*', async (c, next) => {
	const authMiddleware = basicAuth({
		username: c.env.BASIC_AUTH_USER,
		password: c.env.BASIC_AUTH_PASS,
	});
	return authMiddleware(c, next);
});

protectedApp.get('/', (c) => c.env.ASSETS.fetch(c.req.raw));
protectedApp.get('/analytics', (c) => c.env.ASSETS.fetch(c.req.raw));

protectedApp.get('/api/links', async (c) => {
	try {
		const { results } = await c.env.DB.prepare('SELECT slug, url FROM links ORDER BY created_at DESC').all();
		return c.json(results);
	} catch (e: any) {
		return c.json({ error: e.message }, 500);
	}
});

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

// Monta il gruppo di rotte protette sull'app principale
app.route('/', protectedApp);

// Fallback per qualsiasi altra rotta non gestita, servendo asset statici
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
