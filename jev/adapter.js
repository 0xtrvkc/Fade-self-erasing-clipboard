/* Application adapter; all writes require an explicit action button. */
(function () {
  'use strict';
  function init() {
    let selected = [];
    let preparedQuery = '';
    let candidateBox;
    JevUI.mount({
      title: 'Search and organize vault notes',
      description:
        'Load up to 50 text/link candidates, select the notes you want to send, then run semantic search. Files, images and temporary clips are excluded. Long notes send their first 2,000 characters only.',
      fields: [
        {
          key: 'mode',
          type: 'select',
          label: 'Task',
          options: [
            ['search', 'Semantic search'],
            ['groups', 'Suggest existing groups'],
          ],
        },
        {
          key: 'query',
          label: 'What are you looking for?',
          max: 600,
          placeholder: 'That Cloudflare deployment fix',
        },
      ],
      consent: 'Send the selected vault note text and this query to TypeSafe for this request.',
      runLabel: 'Search selected notes',
      extra(host, fields) {
        const load = document.createElement('button');
        load.type = 'button';
        load.textContent = 'Choose notes to search';
        candidateBox = document.createElement('div');
        candidateBox.className = 'jev-checklist';
        host.append(load, candidateBox);
        load.addEventListener('click', () => {
          try {
            const items = window.JevApp.vaultCandidates(fields.query.value);
            selected = items;
            preparedQuery = fields.query.value;
            candidateBox.replaceChildren();
            for (const item of items) {
              const label = document.createElement('label'),
                check = document.createElement('input');
              check.type = 'checkbox';
              check.checked = false;
              check.dataset.clipKey = item.key;
              label.append(check, document.createTextNode(item.title + ' · ' + item.group));
              candidateBox.append(label);
            }
            if (!items.length)
              candidateBox.textContent = 'No text or link notes are loaded in this vault.';
            window.dispatchEvent(new Event('jev:context'));
          } catch (error) {
            candidateBox.textContent = error.message;
          }
        });
      },
      input(v) {
        if (v.query !== preparedQuery) throw new Error('Choose notes again for the current query.');
        const wanted = new Set(
          [...candidateBox.querySelectorAll('input:checked')].map((x) => x.dataset.clipKey),
        );
        const live = window.JevApp.vaultCandidates(v.query);
        const items = selected
          .filter((x) => wanted.has(x.key))
          .map((x) => {
            const current = live.find((y) => y.key === x.key);
            if (!current || current.text !== x.text || current.title !== x.title)
              throw new Error('Vault notes changed. Choose notes again.');
            return {
              id: x.key,
              title: x.title,
              text: x.text.slice(0, 2000),
              excerpt: x.text.length > 2000,
            };
          });
        return {
          query: v.query || 'Group these notes',
          mode: v.mode,
          items,
          groups: window.JevApp.vaultGroups(),
        };
      },
      actionLabel: 'Show clip',
      action(row, input) {
        window.JevApp.showClip(input.items[row.index].id);
      },
    });
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
