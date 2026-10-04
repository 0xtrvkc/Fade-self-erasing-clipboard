/* Browser-side explicit, previewable Jev requests. API keys stay on the server. */
(function (root) {
  'use strict';
  const C = root.JevContract,
    F = root.JevFeature;
  const el = (tag, text) => {
    const x = document.createElement(tag);
    if (text !== undefined) x.textContent = text;
    return x;
  };
  function mount(options) {
    const host = document.getElementById('jevMount');
    if (!host) return;
    const panel = el('section');
    panel.className = 'jev-panel';
    panel.setAttribute('aria-labelledby', 'jevTitle');
    const title = el('h2', options.title);
    title.id = 'jevTitle';
    panel.append(title, el('p', options.description));
    const fields = {};
    for (const field of options.fields || []) {
      const label = el('label', field.label);
      const x = el(field.type === 'select' ? 'select' : 'textarea');
      x.id = 'jev-' + field.key;
      x.name = field.key;
      if (field.type === 'select')
        for (const [value, text] of field.options) {
          const o = el('option', text);
          o.value = value;
          x.append(o);
        }
      else {
        x.rows = field.rows || 2;
        x.maxLength = field.max || 2000;
        x.placeholder = field.placeholder || '';
      }
      label.append(x);
      panel.append(label);
      fields[field.key] = x;
    }
    const extra = el('div');
    panel.append(extra);
    options.extra?.(extra, fields);
    const settings = el('details'),
      summary = el('summary', 'Jev connection');
    settings.append(summary);
    const endpointLabel = el('label', 'Endpoint URL'),
      endpoint = el('input');
    endpoint.type = 'url';
    endpoint.id = 'jev-endpoint';
    endpoint.placeholder = 'https://your-worker.workers.dev/api/jev';
    let saved = '';
    try {
      saved = localStorage.getItem('jev.endpoint.' + F.id) || '';
    } catch {}
    endpoint.value = root.JEV_CONFIG?.endpoint || saved || options.endpoint || '';
    endpointLabel.append(endpoint);
    settings.append(endpointLabel);
    const tokenLabel = el('label', 'Feature access token (kept only in this page session)'),
      token = el('input');
    token.type = 'password';
    token.autocomplete = 'off';
    token.id = 'jev-token';
    tokenLabel.hidden = !F.private || !!options.cookieAuth;
    tokenLabel.append(token);
    settings.append(tokenLabel);
    settings.append(el('p', 'Set up once using JEV.md. Never enter a TypeSafe API key here.'));
    panel.append(settings);
    const previewButton = el('button', 'Preview input');
    previewButton.type = 'button';
    previewButton.id = 'jev-preview-button';
    const previewDetails = el('details'),
      previewSummary = el('summary', 'Input sent for this request'),
      preview = el('pre');
    preview.id = 'jev-preview';
    previewDetails.append(previewSummary, preview);
    const consentLabel = el('label'),
      consent = el('input');
    consent.type = 'checkbox';
    consent.id = 'jev-consent';
    consentLabel.append(
      consent,
      document.createTextNode(
        options.consent ||
          'Send only the previewed request and context to TypeSafe for this check.',
      ),
    );
    const run = el('button', options.runLabel || 'Run Jev');
    run.type = 'button';
    run.id = 'jev-run';
    const clear = el('button', 'Clear result');
    clear.type = 'button';
    clear.id = 'jev-clear';
    const status = el('p', 'Optional Jev feature. Existing tools work without it.');
    status.className = 'jev-status';
    status.id = 'jev-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const filter = el('select');
    filter.id = 'jev-filter';
    filter.className = 'jev-filter';
    filter.setAttribute('aria-label', 'Filter Jev results');
    filter.hidden = true;
    const results = el('ul');
    results.id = 'jev-results';
    results.className = 'jev-results';
    panel.append(previewButton, previewDetails, consentLabel, run, clear, status, filter, results);
    host.replaceChildren(panel);
    let serial = 0,
      active = null,
      current = null;
    const cache = new Map();
    const snapshot = () =>
      JSON.parse(
        JSON.stringify(
          options.input(Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, x.value]))),
        ),
      );
    function getSpec() {
      const input = snapshot(),
        spec = F.build(input);
      if (new TextEncoder().encode(JSON.stringify({ input })).length > 60000)
        throw new Error('Selected context is too large. Select fewer items.');
      return { input, spec };
    }
    function reset() {
      serial++;
      active?.abort();
      active = null;
      current = null;
      results.replaceChildren();
      filter.hidden = true;
      run.disabled = false;
      panel.setAttribute('aria-busy', 'false');
      status.textContent = 'Result cleared. No app settings changed.';
    }
    function display() {
      results.replaceChildren();
      const rows = current.rows.filter((r) => !filter.value || r.label === filter.value);
      for (const row of rows) {
        const item = el('li');
        item.append(
          el('strong', row.title),
          el('small', row.label + ' · confidence ' + Math.round(row.confidence * 100) + '%'),
          el('p', row.detail),
        );
        if (row.nextStep) item.append(el('p', 'Next check: ' + row.nextStep));
        if (options.action && (row.action || row.index !== undefined)) {
          const button = el('button', options.actionLabel || 'Open');
          button.type = 'button';
          button.className = 'jev-action';
          button.addEventListener('click', () => {
            try {
              if (JSON.stringify(snapshot()) !== current.key)
                throw new Error('Context changed. Run Jev again before applying this result.');
              options.action(row, current.input, fields, current.rows);
              status.textContent =
                'Selection applied. ' +
                (options.actionNote || 'Existing calculations and rules remain in charge.');
            } catch (error) {
              status.textContent = error.message;
            }
          });
          item.append(button);
        }
        results.append(item);
      }
      if (!rows.length)
        results.append(el('li', 'No relevant matches. Try a more specific request.'));
    }
    previewButton.addEventListener('click', () => {
      try {
        const { input } = getSpec();
        preview.textContent = JSON.stringify(input, null, 2);
        previewDetails.open = true;
        status.textContent = 'Review this input before sending. No request sent yet.';
      } catch (error) {
        status.textContent = error.message;
      }
    });
    run.addEventListener('click', async () => {
      const ticket = ++serial;
      active?.abort();
      let requestController;
      try {
        if (!consent.checked)
          throw new Error('Review the input and select the consent checkbox first.');
        const { input, spec } = getSpec(),
          key = JSON.stringify(input),
          url = C.endpoint(endpoint.value, location.href);
        if (!endpoint.value) throw new Error('Configure the Jev endpoint in Jev connection.');
        if (F.private && !options.cookieAuth && !token.value)
          throw new Error('Enter the feature access token for this session.');
        preview.textContent = JSON.stringify(input, null, 2);
        requestController = new AbortController();
        active = requestController;
        run.disabled = true;
        results.replaceChildren();
        filter.hidden = true;
        current = null;
        panel.setAttribute('aria-busy', 'true');
        status.textContent = 'Checking with Jev…';
        try {
          localStorage.setItem('jev.endpoint.' + F.id, url);
        } catch {}
        const cacheKey = JSON.stringify([url, token.value, key]);
        let data = cache.get(cacheKey);
        if (!data) {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token.value && !options.cookieAuth
                ? { Authorization: 'Bearer ' + token.value }
                : {}),
            },
            credentials: options.cookieAuth ? 'same-origin' : 'omit',
            body: JSON.stringify({ input }),
            signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(30000)]),
          });
          let raw;
          try {
            raw = await response.json();
          } catch {
            throw new Error('Endpoint did not return JSON. Check the Jev connection.');
          }
          if (!response.ok) throw new Error(raw.error || 'Jev request failed.');
          data = C.validate(spec.questions, raw);
          cache.set(cacheKey, data);
          if (cache.size > 10) cache.delete(cache.keys().next().value);
        }
        if (ticket !== serial) return;
        if (JSON.stringify(snapshot()) !== key)
          throw new Error('Input changed during the request. Run Jev again.');
        current = { input, key, rows: F.present(input, data.answers) };
        const labels = [...new Set(current.rows.map((r) => r.label))];
        filter.replaceChildren();
        for (const label of ['', ...labels]) {
          const o = el('option', label || 'All results');
          o.value = label;
          filter.append(o);
        }
        filter.hidden = !options.filter || labels.length < 2;
        display();
        status.textContent =
          'Model: ' +
          data.model +
          ' · ' +
          new Date().toLocaleTimeString() +
          ' · bounded judgment, not a verified fact. Low-confidence results need review.';
      } catch (error) {
        if (ticket === serial) {
          current = null;
          results.replaceChildren();
          filter.hidden = true;
          status.textContent =
            error.name === 'TimeoutError'
              ? 'Jev timed out. Existing tools still work.'
              : error.name === 'AbortError'
                ? 'Request cancelled.'
                : error.message;
        }
      } finally {
        if (ticket === serial) {
          run.disabled = false;
          active = null;
          panel.setAttribute('aria-busy', 'false');
        }
      }
    });
    clear.addEventListener('click', reset);
    filter.addEventListener('change', () => {
      if (current) display();
    });
    panel.addEventListener('input', (e) => {
      if (e.target !== consent && e.target !== filter) {
        reset();
        preview.textContent = '';
        consent.checked = false;
      }
    });
    root.addEventListener('jev:context', () => {
      cache.clear();
      reset();
      preview.textContent = '';
      consent.checked = false;
    });
    return { reset, fields };
  }
  root.JevUI = Object.freeze({ mount });
})(globalThis);
