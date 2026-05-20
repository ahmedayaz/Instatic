/**
 * Forms Builder — `pagebuilder.forms.form`
 *
 * Container module that wraps `<form>` and POSTs to the plugin's public
 * submission endpoint. Children (inputs, selects, submit button, etc.) are
 * dropped inside. A hidden `_form_id` input carries the form identifier
 * so the server knows which form was submitted.
 */
import { control, defineModule, html, raw, safeUrl } from '@pagebuilder/plugin-sdk'

const SUBMIT_PATH =
  '/admin/api/cms/plugins/pagebuilder.forms/runtime/submit'

export default defineModule({
  id: 'pagebuilder.forms.form',
  name: 'Form',
  description: 'A form container. Drop input fields inside and configure the submission target.',
  category: 'Forms',
  htmlTag: 'form',
  canHaveChildren: true,
  defaults: {
    formId: '',
    formName: 'Contact Form',
    successMessage: 'Thanks! We got your message.',
    redirectUrl: '',
  },
  schema: {
    formId: control.text('Form ID', {
      placeholder: 'contact',
      description: 'Unique slug that identifies this form in the submissions list.',
    }),
    formName: control.text('Form Name', {
      placeholder: 'Contact Form',
      description: 'Human-readable label shown in the admin dashboard.',
    }),
    successMessage: control.text('Success Message', {
      placeholder: 'Thanks! We got your message.',
      description: 'Shown (or returned) after a successful submission when no redirect URL is set.',
    }),
    redirectUrl: control.url('Redirect URL', {
      description: 'Optional. If set, visitors are redirected here after a successful submission.',
    }),
  },
  render: ({ props, children }) => {
    const action = SUBMIT_PATH
    const redirectAttr = props.redirectUrl
      ? ` data-redirect="${safeUrl(props.redirectUrl)}"`
      : ''
    // Inline submit-intercept script — turns the form into an AJAX POST so
    // the server's JSON response renders as an inline status message
    // instead of replacing the page. The script is keyed off the form's
    // class + a fresh id so multiple forms on one page each get their
    // own interceptor. IIFE'd to avoid leaking globals; idempotent so
    // visitors who refresh / re-render via SPA navigation don't double-
    // bind. The fallback (no JS) is a plain `<form action>` POST that
    // still works — the server returns JSON which the browser renders
    // as text, ugly but functional.
    const submitScript = `(function(){
  var form = document.currentScript && document.currentScript.previousElementSibling;
  if (!form || form.dataset.pbFormsBound === '1') return;
  form.dataset.pbFormsBound = '1';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var submitBtn = form.querySelector('button[type=submit], input[type=submit]');
    if (submitBtn) { submitBtn.disabled = true; }
    var prevStatus = form.querySelector('.pb-forms-status');
    if (prevStatus) prevStatus.remove();
    var body = {};
    var fd = new FormData(form);
    fd.forEach(function (v, k) { body[k] = typeof v === 'string' ? v : ''; });
    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return { ok: res.ok }; }).then(function (data) { return { res: res, data: data }; });
    }).then(function (r) {
      var ok = r.res.ok && (r.data.ok !== false);
      var redirect = form.dataset.redirect;
      if (ok && redirect) { window.location.assign(redirect); return; }
      var msg = ok
        ? (form.dataset.successMessage || (r.data.message || 'Thanks!'))
        : ((r.data && r.data.error) || 'Sorry — something went wrong. Please try again.');
      var node = document.createElement('div');
      node.className = 'pb-forms-status pb-forms-status--' + (ok ? 'success' : 'error');
      node.setAttribute('role', ok ? 'status' : 'alert');
      node.textContent = msg;
      form.appendChild(node);
      if (ok) { form.reset(); }
    }).catch(function () {
      var node = document.createElement('div');
      node.className = 'pb-forms-status pb-forms-status--error';
      node.setAttribute('role', 'alert');
      node.textContent = 'Network error. Please try again.';
      form.appendChild(node);
    }).finally(function () {
      if (submitBtn) { submitBtn.disabled = false; }
    });
  });
})();`
    return {
      html: html`<form
  class="pb-forms-form"
  method="post"
  action="${action}"
  data-success-message="${props.successMessage}"${raw(redirectAttr)}
>
  <input type="hidden" name="_form_id" value="${props.formId}">
  ${raw(children.join('\n'))}
</form>
<script>${raw(submitScript)}</script>`,
      // Selectors are UN-qualified by parent (no `.pb-forms-form .foo`) so
      // they match whether the field is rendered as a descendant of the
      // form (published page) or as a sibling outside it (editor canvas,
      // where `canHaveChildren: true` + `dangerouslySetInnerHTML` forces
      // children to be portaled outside the parent's emitted HTML). The
      // `pb-forms-*` namespace is unique enough that flat selectors don't
      // risk leaking onto unrelated page content.
      css: `
.pb-forms-form{display:flex;flex-direction:column;gap:16px;}
.pb-forms-field{display:flex;flex-direction:column;gap:6px;margin-bottom:0;}
.pb-forms-label{font-size:0.875rem;font-weight:500;color:inherit;}
.pb-forms-label .pb-forms-required{color:#c0392b;margin-left:2px;}
.pb-forms-control{width:100%;padding:8px 12px;border:1px solid #d0d0d0;border-radius:4px;font-family:inherit;font-size:0.9375rem;background:#fff;color:inherit;box-sizing:border-box;}
.pb-forms-control:focus{outline:2px solid #4a90e2;outline-offset:1px;border-color:transparent;}
.pb-forms-help{font-size:0.8125rem;color:#666;}
textarea.pb-forms-control{resize:vertical;min-height:80px;}
select.pb-forms-control{appearance:auto;}
.pb-forms-status{margin-top:12px;padding:10px 14px;border-radius:4px;font-size:0.9rem;}
.pb-forms-status--success{background:#f0faf4;border:1px solid #81c9a0;color:#1a6636;}
.pb-forms-status--error{background:#fff5f5;border:1px solid #f0a0a0;color:#7b1414;}
`,
    }
  },
})
