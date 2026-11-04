import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { requireScope } from '../auth.js';
import { logEvent } from '../audit.js';
import {
  createTemplate, listTemplates, loadTemplate, pdfPages, publishTemplate, renderPdf, renderTemplate, requireTemplateAdmin, revertTemplate,
  sampleRecord, saveTemplateDraft, setDefaultTemplate, templateData, templateOut, type TemplateInput
} from '../templates.js';

// Document templates (templates.ts): admins list, write, publish and preview
// them. Customers see them through the public quote routes (public.ts).

type IdParams = { id: string };

export async function templateRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { object?: string } }>('/v1/document-templates', async (req) => {
    requireScope(req.principal!, 'read');
    return { results: (await listTemplates(req.query.object)).map((t) => templateOut(t, false)) };
  });

  app.post<{ Body: TemplateInput }>('/v1/document-templates', async (req, reply) => {
    const t = await createTemplate(req.principal!, req.body ?? {});
    await logEvent(req, 'settings.updated', { target: { type: 'document_template', id: t.id } });
    reply.code(201);
    return templateOut(t);
  });

  app.get<{ Params: IdParams }>('/v1/document-templates/:id', async (req) => {
    requireScope(req.principal!, 'read');
    return templateOut(await loadTemplate(pool, req.params.id));
  });

  app.put<{ Params: IdParams; Body: TemplateInput }>('/v1/document-templates/:id/draft', async (req) => {
    return templateOut(await saveTemplateDraft(req.principal!, req.params.id, req.body ?? {}));
  });

  app.post<{ Params: IdParams }>('/v1/document-templates/:id/publish', async (req) => {
    const t = await publishTemplate(req.principal!, req.params.id);
    await logEvent(req, 'settings.updated', { target: { type: 'document_template', id: t.id } });
    return templateOut(t);
  });

  app.post<{ Params: IdParams }>('/v1/document-templates/:id/revert', async (req) => {
    return templateOut(await revertTemplate(req.principal!, req.params.id));
  });

  app.post<{ Params: IdParams; Body: { default?: unknown } }>('/v1/document-templates/:id/default', async (req) => {
    if (typeof req.body?.default !== 'boolean') throw badRequest('default must be true or false');
    return templateOut(await setDefaultTemplate(req.principal!, req.params.id, req.body.default));
  });

  // The data the template gets for a record (to see what to write).
  app.get<{ Params: IdParams; Querystring: { record_id?: string; draft?: string } }>('/v1/document-templates/:id/data', async (req) => {
    requireTemplateAdmin(req.principal!);
    const t = await loadTemplate(pool, req.params.id);
    const recordId = req.query.record_id || (await sampleRecord(t.object));
    const { data, warnings } = await templateData(t, recordId, req.query.draft !== '0');
    return { record_id: recordId, data, warnings };
  });

  // Draws the template for a record (draft by default): the page as HTML, or the PDF.
  app.post<{ Params: IdParams; Body: { record_id?: string; draft?: boolean; format?: 'html' | 'pdf' } }>('/v1/document-templates/:id/render', async (req, reply) => {
    requireTemplateAdmin(req.principal!);
    const t = await loadTemplate(pool, req.params.id);
    const b = req.body ?? {};
    const recordId = b.record_id || (await sampleRecord(t.object));
    const draft = b.draft !== false;
    const out = await renderTemplate(t, recordId, draft);
    reply.header('cache-control', 'no-store');
    if (b.format === 'pdf') {
      const pdf = await renderPdf(t, out.html);
      reply.header('x-pdf-pages', String(pdfPages(pdf))).header('x-warnings', encodeURIComponent(JSON.stringify(out.warnings).slice(0, 4000)));
      reply.header('content-disposition', `inline; filename="${(t.name ?? 'template').replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '-') || 'template'}.pdf"`);
      return reply.type('application/pdf').send(pdf);
    }
    return { record_id: recordId, html: out.html, warnings: out.warnings };
  });
}
