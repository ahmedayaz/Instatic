/**
 * pagebuilder.newsletter.subscribe-form
 *
 * Renders a clean semantic HTML subscribe form. Submits via GET to the
 * plugin's public /subscribe endpoint so it works from published pages
 * without JavaScript.
 *
 * Props:
 *   listIds         — comma-separated list IDs to subscribe to (empty = default list)
 *   successMessage  — message shown on the server's confirmation page
 *   consentLabel    — text beside the consent checkbox
 *   submitLabel     — submit button text
 *   emailPlaceholder — email input placeholder
 *   namePlaceholder  — name input placeholder
 *   showNameField    — toggle the optional name field
 *   successUrl       — where to redirect after a successful subscription
 */
import { control, defineModule, html, safeUrl } from '@core/plugin-sdk'

const PLUGIN_ID = 'pagebuilder.newsletter'
const SUBSCRIBE_PATH = `/admin/api/cms/plugins/${PLUGIN_ID}/runtime/subscribe`

export default defineModule({
  id: `${PLUGIN_ID}.subscribe-form`,
  name: 'Newsletter Subscribe Form',
  description: 'Email subscribe form — submits to the Newsletter plugin\'s public /subscribe endpoint.',
  category: 'Newsletter',
  htmlTag: 'section',
  version: '0.1.0',
  defaults: {
    listIds: '',
    successMessage: 'Thank you for subscribing!',
    consentLabel: 'I agree to receive email newsletters.',
    submitLabel: 'Subscribe',
    emailPlaceholder: 'your@email.com',
    namePlaceholder: 'Your name (optional)',
    showNameField: false,
    successUrl: '/',
  },
  schema: {
    listIds: control.text('List IDs', {
      placeholder: 'id1,id2',
      description: 'Comma-separated list IDs to subscribe to. Leave blank to use the default list.',
    }),
    successUrl: control.url('Success URL', {
      description: 'Page to redirect to after a successful subscription.',
    }),
    successMessage: control.text('Success message', {
      description: 'Shown on the server confirmation page (if no success URL redirect is set).',
    }),
    consentLabel: control.text('Consent label'),
    submitLabel: control.text('Submit button label'),
    emailPlaceholder: control.text('Email placeholder'),
    namePlaceholder: control.text('Name placeholder'),
    showNameField: control.toggle('Show name field'),
  },
  render: ({ props }) => {
    const action = safeUrl(SUBSCRIBE_PATH)
    const listIdsValue = String(props.listIds ?? '').trim()

    const nameField = props.showNameField
      ? html`<div class="nl-subscribe__field">
          <label class="nl-subscribe__label" for="nl-name">${props.namePlaceholder}</label>
          <input
            class="nl-subscribe__input"
            type="text"
            id="nl-name"
            name="name"
            placeholder="${props.namePlaceholder}"
            autocomplete="name"
          />
        </div>`
      : ''

    const listIdsField = listIdsValue
      ? html`<input type="hidden" name="listIds" value="${listIdsValue}" />`
      : ''

    return {
      html: html`
        <section class="nl-subscribe">
          <form class="nl-subscribe__form" method="GET" action="${action}" novalidate>
            <div class="nl-subscribe__field">
              <label class="nl-subscribe__label" for="nl-email">${props.emailPlaceholder}</label>
              <input
                class="nl-subscribe__input"
                type="email"
                id="nl-email"
                name="email"
                placeholder="${props.emailPlaceholder}"
                autocomplete="email"
                required
              />
            </div>
            ${nameField}
            <div class="nl-subscribe__consent">
              <label class="nl-subscribe__consent-label">
                <input type="checkbox" name="consent" value="true" required />
                <span>${props.consentLabel}</span>
              </label>
            </div>
            ${listIdsField}
            <input type="hidden" name="redirect" value="${safeUrl(String(props.successUrl ?? '/'))}" />
            <button class="nl-subscribe__btn" type="submit">
              ${props.submitLabel}
            </button>
          </form>
        </section>
      `,
      css: `
        .nl-subscribe { max-width: 480px; margin: 0 auto; padding: 32px 16px; font-family: inherit; }
        .nl-subscribe__form { display: flex; flex-direction: column; gap: 12px; }
        .nl-subscribe__field { display: flex; flex-direction: column; gap: 4px; }
        .nl-subscribe__label { font-size: 0.875rem; color: #555; }
        .nl-subscribe__input {
          padding: 10px 14px;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 1rem;
          font-family: inherit;
          width: 100%;
          box-sizing: border-box;
        }
        .nl-subscribe__input:focus { outline: 2px solid #111; outline-offset: 2px; }
        .nl-subscribe__consent { font-size: 0.875rem; color: #555; }
        .nl-subscribe__consent-label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
        .nl-subscribe__btn {
          padding: 12px 24px;
          background: #111;
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 1rem;
          font-family: inherit;
          font-weight: 600;
          cursor: pointer;
          align-self: flex-start;
        }
        .nl-subscribe__btn:hover { background: #333; }
        .nl-subscribe__btn:focus { outline: 2px solid #111; outline-offset: 2px; }
      `,
    }
  },
})
