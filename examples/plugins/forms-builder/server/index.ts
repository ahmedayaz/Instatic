/**
 * Forms Builder — server entrypoint.
 *
 * Lifecycle:
 *   install   — no-op (resources are declared in the manifest; host creates them)
 *   activate  — register public POST /submit + authenticated admin routes
 *   deactivate — no-op (routes auto-removed by host)
 *   uninstall — remove all stored submissions
 */
import type { ServerPluginApi, ServerPluginModule } from '@core/plugin-sdk'
import { registerSubmitRoute } from './submit'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log('Forms Builder installed')
  },

  activate(api: ServerPluginApi) {
    api.plugin.log('Forms Builder activated')

    const submissions = api.cms.storage.collection('submissions')

    // Public submission endpoint — unauthenticated POST from published pages
    registerSubmitRoute(api)

    // Admin: list submissions
    api.cms.routes.get('/submissions', 'plugins.manage', async () => {
      const all = await submissions.list()
      return { submissions: all }
    })

    // Admin: resend email for a specific submission
    api.cms.routes.post('/resend', 'plugins.manage', async (ctx) => {
      const url = new URL(ctx.req.url)
      const id = url.searchParams.get('id') ?? ''
      if (!id) return { error: 'Missing submission id' }

      const all = await submissions.list()
      const record = all.find((r) => r.id === id)
      if (!record) return { error: 'Submission not found' }

      const { sendSubmissionEmail } = await import('./email')
      const payload = (() => {
        try {
          return JSON.parse(String(record.data['payload'] ?? '{}')) as Record<string, unknown>
        } catch (_e) {
          return {}
        }
      })()

      try {
        await sendSubmissionEmail(
          {
            formName: String(record.data['form-id'] ?? ''),
            formId: String(record.data['form-id'] ?? ''),
            pagePath: String(record.data['page-path'] ?? ''),
            submittedAt: String(record.data['submitted-at'] ?? record.createdAt),
            fields: payload,
          },
          {
            provider:
              (api.cms.settings.get<string>('provider') as 'resend' | 'postmark' | 'mailgun') ??
              'resend',
            apiKey: api.cms.settings.get<string>('apiKey') ?? '',
            mailgunDomain: api.cms.settings.get<string>('mailgunDomain'),
            fromAddress: api.cms.settings.get<string>('fromAddress') ?? '',
            defaultToAddress: api.cms.settings.get<string>('defaultToAddress') ?? '',
            subjectTemplate:
              api.cms.settings.get<string>('subjectTemplate') ?? '{{form_name}} — new submission',
          },
        )
        await submissions.update(id, { status: 'sent', 'error-message': '' })
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[plugin:pagebuilder.forms] Resend failed:', err)
        await submissions
          .update(id, { status: 'failed', 'error-message': message })
          .catch((_e) => { /* non-fatal */ })
        return { error: message }
      }
    })

    // Admin: delete a submission
    api.cms.routes.delete('/submissions/:id', 'plugins.manage', async (ctx) => {
      const url = new URL(ctx.req.url)
      const id = url.pathname.split('/').at(-1) ?? ''
      if (!id) return { error: 'Missing id' }
      await submissions.delete(id)
      return { ok: true }
    })
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('Forms Builder deactivated')
  },

  async uninstall(api: ServerPluginApi) {
    const submissions = api.cms.storage.collection('submissions')
    const all = await submissions.list()
    await Promise.all(all.map((r) => submissions.delete(r.id)))
    api.plugin.log(`Forms Builder removed ${all.length} submissions`)
  },
}

export default mod
