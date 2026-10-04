/* Typed Jev boundary. No credentials, network calls or app mutations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.JevContract = api;
})(globalThis, function () {
  'use strict';
  const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
  const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
  function text(x, label, max = 2000) {
    if (typeof x !== 'string' || !x.trim() || x.length > max)
      throw new Error(label + ' is required (maximum ' + max + ' characters).');
    return x.trim();
  }
  function list(x, label, max = 50) {
    if (!Array.isArray(x) || !x.length || x.length > max)
      throw new Error(label + ' requires 1–' + max + ' items.');
    return x;
  }
  function choice(instructions, criteria) {
    return { type: 'choice', instructions, criteria };
  }
  function score(instructions) {
    return {
      type: 'score',
      instructions,
      criteria: [
        'Unrelated to the request',
        'Tangential; does not solve the request',
        'Useful partial match',
        'Direct match for the stated need',
      ],
    };
  }
  function probability(x) {
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  }
  function validate(questions, response) {
    if (!object(response) || !object(response.answers) || typeof response.model !== 'string')
      throw new Error('Invalid Jev response.');
    const clean = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = response.answers[id];
      if (!object(a) || a.type !== q.type)
        throw new Error('Missing or mismatched Jev answer: ' + id);
      if (q.type === 'noul') {
        if (!probability(a.noul)) throw new Error('Invalid probability.');
        clean[id] = { type: a.type, noul: a.noul };
        continue;
      }
      if (!probability(a.confidence) || !object(a.probabilities))
        throw new Error('Invalid confidence or distribution.');
      const keys =
        q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
      if (
        Object.keys(a.probabilities).length !== keys.length ||
        keys.some((k) => !own(a.probabilities, k) || !probability(a.probabilities[k])) ||
        Math.abs(keys.reduce((s, k) => s + a.probabilities[k], 0) - 1) > 0.02
      )
        throw new Error('Invalid probability distribution.');
      if (q.type === 'choice') {
        if (
          !own(q.criteria, a.choice) ||
          a.probabilities[a.choice] + 1e-6 < Math.max(...Object.values(a.probabilities))
        )
          throw new Error('Invalid choice.');
        clean[id] = {
          type: a.type,
          choice: a.choice,
          confidence: a.confidence,
          probabilities: a.probabilities,
        };
      } else {
        const expected = keys.reduce((sum, k) => sum + Number(k) * a.probabilities[k], 0);
        if (
          typeof a.score !== 'number' ||
          !Number.isFinite(a.score) ||
          a.score < 0 ||
          a.score > q.criteria.length - 1 ||
          Math.abs(a.score - expected) > 0.03
        )
          throw new Error('Invalid score.');
        clean[id] = {
          type: a.type,
          score: a.score,
          confidence: a.confidence,
          probabilities: a.probabilities,
        };
      }
    }
    return { model: response.model, answers: clean };
  }
  function decision(a, threshold = 0.8) {
    return a && a.confidence >= threshold ? a.choice : 'review';
  }
  function candidates(values, label) {
    return list(values, label).map((x, i) => {
      if (!object(x)) throw new Error('Invalid candidate.');
      return {
        id: 'item' + i,
        title: text(x.title || x.id, label + ' title', 160),
        text: text(x.text || x.description || x.title, label + ' text', 2000),
      };
    });
  }
  function rank(items, answers) {
    return items
      .map((x, i) => ({ ...x, answer: answers['relevance' + i] }))
      .filter((x) => x.answer.score >= 1.5)
      .sort((a, b) => b.answer.score - a.answer.score || a.id.localeCompare(b.id));
  }
  function endpoint(value, base) {
    const u = new URL(value, base);
    if (
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      !(
        u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      )
    )
      throw new Error('Use an HTTPS endpoint (localhost HTTP is allowed).');
    return u.href;
  }
  return Object.freeze({
    text,
    list,
    choice,
    score,
    validate,
    decision,
    candidates,
    rank,
    endpoint,
  });
});
