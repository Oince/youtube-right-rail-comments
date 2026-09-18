const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '../youtube-right-rail-comments.user.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, { disabled = false } = {}) {
  const content = disabled
    ? '<ytd-message-renderer>Comments are turned off</ytd-message-renderer>'
    : '<ytd-comments-header-renderer></ytd-comments-header-renderer>';
  const dom = new JSDOM(`<html lang="en"><head></head><body><ytd-app>
    <ytd-watch-flexy video-id="A"><div id="primary"><div id="below">
      <ytd-comments id="comments">${content}</ytd-comments>
    </div></div><div id="secondary"><div id="secondary-inner">
      <div id="related">related</div>
    </div></div></ytd-watch-flexy></ytd-app></body></html>`, {
    url: 'https://www.youtube.com/watch?v=A',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.innerWidth = 1440;
  // jsdom has no layout engine: supply the supported two-column geometry.
  w.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.id === 'primary'
      ? { width: 900, left: 0, right: 900 }
      : { width: 400, left: 920, right: 1320 };
  };
  // Count evaluations without changing the production script's behavior.
  w.eval(script.replace('function evaluate() {', 'function evaluate() { window.evaluationCount = (window.evaluationCount || 0) + 1;'));
  await sleep(200);
  assert.ok(w.document.querySelector('#ytrrc-root'));
  return { w, document: w.document, watch: w.document.querySelector('ytd-watch-flexy') };
}

function newComments(document) {
  const node = document.createElement('ytd-comments');
  node.id = 'comments';
  node.innerHTML = '<ytd-comments-header-renderer></ytd-comments-header-renderer>';
  return node;
}

function removeMarkers(document) {
  const walker = document.createTreeWalker(document, 128);
  const markers = [];
  while (walker.nextNode()) {
    if (walker.currentNode.data.startsWith('ytrrc:')) markers.push(walker.currentNode);
  }
  markers.forEach(node => node.remove());
}

function selected(document) {
  return document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab;
}

async function theater(watch) {
  watch.setAttribute('theater', '');
  await sleep(200);
}

test('idle DOM settles instead of repeatedly evaluating', async t => {
  const { w } = await setup(t);
  const count = w.evaluationCount;
  await sleep(400);
  assert.equal(w.evaluationCount, count);
});

test('detached panel is recreated and retains native content', async t => {
  const { document } = await setup(t);
  const comments = document.querySelector('#comments');
  const related = document.querySelector('#related');
  const root = document.querySelector('#ytrrc-root');
  root.remove();
  await sleep(200);
  assert.notEqual(document.querySelector('#ytrrc-root'), root);
  assert.equal(document.querySelector('#ytrrc-comments-pane #comments'), comments);
  assert.equal(document.querySelector('#ytrrc-related-pane #related'), related);
});

test('secondary container replacement recovers with the new related content', async t => {
  const { document } = await setup(t);
  const comments = document.querySelector('#comments');
  const inner = document.createElement('div');
  inner.id = 'secondary-inner';
  inner.innerHTML = '<div id="related">new related</div>';
  document.querySelector('#secondary-inner').replaceWith(inner);
  await sleep(200);
  assert.ok(inner.querySelector('#ytrrc-root'));
  assert.equal(document.querySelector('#ytrrc-comments-pane #comments'), comments);
  assert.equal(document.querySelector('#related').textContent, 'new related');
  assert.equal(document.querySelectorAll('#related').length, 1);
});

test('replacement comments are adopted and observed', async t => {
  const { document } = await setup(t);
  document.querySelector('#comments').remove();
  const replacement = newComments(document);
  replacement.replaceChildren();
  document.querySelector('#below').append(replacement);
  await sleep(200);
  assert.equal(document.querySelector('#ytrrc-comments-pane #comments'), replacement);
  assert.ok(document.querySelector('.ytrrc-status'));
  replacement.append(document.createElement('ytd-comments-header-renderer'));
  await sleep(100);
  assert.equal(document.querySelector('.ytrrc-status'), null);
});

test('native reparenting of the existing comments is repaired', async t => {
  const { document } = await setup(t);
  const comments = document.querySelector('#comments');
  document.querySelector('#below').append(comments);
  await sleep(200);
  assert.equal(document.querySelector('#ytrrc-comments-pane #comments'), comments);
  assert.equal(document.querySelectorAll('#comments').length, 1);
});

test('missing markers restore both native nodes on teardown', async t => {
  const { document, watch } = await setup(t);
  const comments = document.querySelector('#comments');
  const related = document.querySelector('#related');
  removeMarkers(document);
  await theater(watch);
  assert.equal(document.querySelector('#below #comments'), comments);
  assert.equal(document.querySelector('#secondary-inner > #related'), related);
  assert.equal(document.querySelector('#ytrrc-root'), null);
});

test('lost original parent falls back to the current primary content area', async t => {
  const { document, watch } = await setup(t);
  const comments = document.querySelector('#comments');
  const below = document.createElement('div');
  below.id = 'below';
  document.querySelector('#below').replaceWith(below);
  await theater(watch);
  assert.equal(below.querySelector('#comments'), comments);
});

test('teardown preserves fresh native content without restoring duplicates', async t => {
  const { document, watch } = await setup(t);
  const freshComments = newComments(document);
  const freshRelated = document.createElement('div');
  freshRelated.id = 'related';
  document.querySelector('#below').append(freshComments);
  document.querySelector('#secondary-inner').append(freshRelated);
  await theater(watch);
  assert.equal(document.querySelector('#comments'), freshComments);
  assert.equal(document.querySelector('#related'), freshRelated);
  assert.equal(document.querySelectorAll('#comments').length, 1);
  assert.equal(document.querySelectorAll('#related').length, 1);
});

test('old video content is not restored into a reused watch renderer', async t => {
  const { w, document, watch } = await setup(t);
  const oldComments = document.querySelector('#comments');
  w.history.pushState({}, '', '/watch?v=B');
  watch.setAttribute('video-id', 'B');
  await sleep(200);
  assert.equal(oldComments.isConnected, false);
  assert.equal(document.querySelector('#primary #comments'), null);
});

test('unavailable timer from the previous video cannot switch the new tab', async t => {
  const { w, document, watch } = await setup(t, { disabled: true });
  document.dispatchEvent(new w.Event('yt-navigate-start'));
  w.history.pushState({}, '', '/watch?v=B');
  watch.setAttribute('video-id', 'B');
  document.querySelector('#comments').replaceWith(newComments(document));
  document.dispatchEvent(new w.Event('yt-navigate-finish'));
  await sleep(1000);
  assert.equal(selected(document), 'comments');
});

test('unavailable comments still switch to related on the current video', async t => {
  const { document } = await setup(t, { disabled: true });
  await sleep(850);
  assert.equal(selected(document), 'related');
});

test('keyboard arrows wrap and Home/End activate and focus the target tab', async t => {
  const { w, document } = await setup(t);
  document.querySelector('#ytrrc-comments-tab').focus();
  for (const [key, expected] of [['ArrowRight', 'related'], ['ArrowRight', 'comments'],
    ['ArrowLeft', 'related'], ['Home', 'comments'], ['End', 'related']]) {
    const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(selected(document), expected);
    assert.equal(document.activeElement.dataset.tab, expected);
    assert.equal(document.querySelectorAll('[role="tab"][tabindex="0"]').length, 1);
  }
});

test('special panels release rail clipping and closing them restores the panel', async t => {
  const { w, document } = await setup(t);
  const secondary = document.querySelector('#secondary');
  assert.equal(w.getComputedStyle(secondary).overflow, 'hidden');
  const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
  panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  document.querySelector('#secondary-inner').append(panel);
  await sleep(200);
  assert.equal(document.querySelector('#ytrrc-root').dataset.suspended, 'true');
  assert.notEqual(w.getComputedStyle(secondary).overflow, 'hidden');
  panel.remove();
  await sleep(200);
  assert.equal(document.querySelector('#ytrrc-root').dataset.suspended, 'false');
  assert.equal(w.getComputedStyle(secondary).overflow, 'hidden');
});
