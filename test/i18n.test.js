// The interface text tables: every language has exactly the keys of the
// English one, and the texts that take arguments produce text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageFor, languages, t, tr } from '../web/assets/js/i18n.js';

/** { 'a.b': 'string' | 'function' | 'array:5' } for every leaf of a table. */
function shape(table, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(table)) {
    const name = prefix + key;
    if (Array.isArray(value)) out[name] = `array:${value.length}`;
    else if (value && typeof value === 'object') shape(value, `${name}.`, out);
    else out[name] = typeof value;
  }
  return out;
}

test('there are five interface languages', () => {
  assert.deepEqual(Object.keys(languages).sort(), ['en', 'fr', 'ja', 'ru', 'zh']);
});

test('every language has the same texts as English', () => {
  const english = shape(languages.en);
  for (const [code, table] of Object.entries(languages)) {
    assert.deepEqual(shape(table), english, `the ${code} table does not match the English one`);
  }
});

test('texts with arguments produce non-empty text in every language', () => {
  for (const [code, table] of Object.entries(languages)) {
    for (const [name, kind] of Object.entries(shape(table))) {
      let value = table;
      for (const part of name.split('.')) value = value[part];
      const text = kind === 'function' ? value(3, 'x') : kind.startsWith('array') ? value.join('') : value;
      assert.equal(typeof text, 'string', `${code}.${name}`);
      assert.ok(text.trim().length > 0, `${code}.${name} is empty`);
      assert.ok(!text.includes('undefined'), `${code}.${name}: ${text}`);
    }
  }
});

test('counts are worded correctly', () => {
  const { en, fr, ru, ja, zh } = languages;
  assert.deepEqual([en.lines(1), en.lines(2)], ['1 line', '2 lines']);
  assert.deepEqual([fr.lines(0), fr.lines(1), fr.lines(2)], ['0 ligne', '1 ligne', '2 lignes']);
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map((n) => ru.filesFound(n)), ['1 файл', '2 файла', '5 файлов', '11 файлов', '21 файл', '22 файла', '25 файлов']);
  assert.deepEqual([ru.lines(1), ru.lines(3), ru.lines(84)], ['1 строка', '3 строки', '84 строки']);
  assert.equal(ja.lines(5), '5 行');
  assert.equal(zh.lines(5), '5 行');
});

test('the language follows the system locale, with English as the fallback', () => {
  assert.equal(languageFor('zh-CN'), 'zh');
  assert.equal(languageFor('zh-Hant-TW'), 'zh');
  assert.equal(languageFor('ja-JP'), 'ja');
  assert.equal(languageFor('fr-CA'), 'fr');
  assert.equal(languageFor('ru'), 'ru');
  assert.equal(languageFor('en-GB'), 'en');
  assert.equal(languageFor('de-DE'), 'en');
  assert.equal(languageFor(''), 'en');
  assert.equal(languageFor(undefined), 'en');
});

test('t() and tr() answer in the current language', () => {
  // Node reports an English locale here unless the machine is set up otherwise.
  const current = languageFor(globalThis.navigator?.language);
  assert.equal(t('send'), languages[current].send);
  assert.equal(t('commands.new'), languages[current].commands.new);
  assert.equal(t('no.such.key'), 'no.such.key');
  const picked = tr('中文', 'English', { ja: '日本語', fr: 'Français', ru: 'Русский' });
  assert.equal(picked, { zh: '中文', en: 'English', ja: '日本語', fr: 'Français', ru: 'Русский' }[current]);
  assert.equal(tr('中文', 'English'), current === 'zh' ? '中文' : 'English');
});
