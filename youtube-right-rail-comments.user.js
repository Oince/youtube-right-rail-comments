// ==UserScript==
// @name         YouTube Right Rail Comments
// @name:ko      YouTube 오른쪽 댓글 패널
// @namespace    local.codex.youtube-right-rail-comments
// @version      0.3.4
// @author       Oince
// @homepageURL  https://github.com/Oince/youtube-right-rail-comments
// @supportURL   https://github.com/Oince/youtube-right-rail-comments/issues
// @downloadURL  https://raw.githubusercontent.com/Oince/youtube-right-rail-comments/main/youtube-right-rail-comments.user.js
// @updateURL    https://raw.githubusercontent.com/Oince/youtube-right-rail-comments/main/youtube-right-rail-comments.user.js
// @description  Switch the native YouTube right rail between comments and related videos without hiding the player.
// @description:ko YouTube 오른쪽 영역에서 댓글과 관련 동영상을 전환하며 영상을 함께 봅니다.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        window.onurlchange
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_ID = 'ytrrc';
  const MIN_VIEWPORT_WIDTH = 1200;
  const COMMENTS_WAIT_MS = 20_000;

  const SELECTORS = {
    watch: 'ytd-watch-flexy',
    primary: '#primary',
    secondary: '#secondary',
    secondaryInner: '#secondary-inner',
    related: 'ytd-watch-next-secondary-results-renderer#related, #related',
    comments: 'ytd-comments#comments',
  };

  const state = {
    generation: 0,
    videoId: null,
    watch: null,
    root: null,
    commentsPane: null,
    relatedPane: null,
    commentsNode: null,
    relatedNode: null,
    commentsMarker: null,
    relatedMarker: null,
    commentsReady: false,
    activeTab: 'comments',
    scrollTop: { comments: 0, related: 0 },
    suspendedBy: null,
    tabBeforeSpecialPanel: 'comments',
    mountTimeout: 0,
    commentsTimeout: 0,
    evaluationTimer: 0,
    retryTimer: 0,
    specialObserver: null,
    commentsObserver: null,
    appObserver: null,
    observerTarget: null,
  };

  const labels = () => {
    const korean = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('ko');
    return korean
      ? {
          comments: '댓글',
          related: '관련 동영상',
          loading: '댓글을 불러오는 중…',
          loadFailed: '댓글을 불러오지 못했습니다.',
          retry: '다시 시도',
          unavailable: '이 영상에서는 댓글을 사용할 수 없어 관련 동영상을 표시합니다.',
        }
      : {
          comments: 'Comments',
          related: 'Related videos',
          loading: 'Loading comments…',
          loadFailed: 'Comments could not be loaded.',
          retry: 'Retry',
          unavailable: 'Comments are unavailable for this video. Showing related videos.',
        };
  };

  function addStyles() {
    if (document.getElementById(`${SCRIPT_ID}-styles`)) return;

    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-styles`;
    style.textContent = `
      html.${SCRIPT_ID}-active ytd-watch-flexy #secondary {
        position: sticky !important;
        top: calc(var(--ytd-masthead-height, 56px) + 12px) !important;
        align-self: flex-start !important;
        height: calc(100vh - var(--ytd-masthead-height, 56px) - 24px) !important;
        max-height: calc(100vh - var(--ytd-masthead-height, 56px) - 24px) !important;
        min-height: 280px !important;
        overflow: hidden !important;
      }

      html.${SCRIPT_ID}-active ytd-watch-flexy #secondary-inner {
        display: flex !important;
        flex-direction: column !important;
        height: 100% !important;
        max-height: 100% !important;
        min-height: 0 !important;
        overflow: hidden !important;
      }

      html.${SCRIPT_ID}-active ytd-watch-flexy #secondary-inner > #related,
      html.${SCRIPT_ID}-active ytd-watch-flexy #secondary-inner > ytd-watch-next-secondary-results-renderer#related {
        display: none !important;
      }

      #${SCRIPT_ID}-root {
        box-sizing: border-box;
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-height: 180px;
        overflow: hidden;
        color: var(--yt-spec-text-primary, #0f0f0f);
        background: var(--yt-spec-base-background, #fff);
        border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, .1));
        border-radius: 12px;
      }

      #${SCRIPT_ID}-root[data-suspended='true'] {
        display: none !important;
      }

      #${SCRIPT_ID}-tabs {
        position: relative;
        z-index: 2;
        display: grid;
        grid-template-columns: 1fr 1fr;
        flex: 0 0 auto;
        gap: 4px;
        padding: 8px;
        background: var(--yt-spec-base-background, #fff);
        border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, .1));
      }

      .${SCRIPT_ID}-tab {
        box-sizing: border-box;
        min-width: 0;
        height: 38px;
        padding: 0 12px;
        overflow: hidden;
        color: var(--yt-spec-text-secondary, #606060);
        font: 500 14px/38px Roboto, Arial, sans-serif;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
        background: transparent;
        border: 0;
        border-radius: 8px;
      }

      .${SCRIPT_ID}-tab:hover {
        background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, .08));
      }

      .${SCRIPT_ID}-tab[aria-selected='true'] {
        color: var(--yt-spec-text-primary, #0f0f0f);
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, .1));
        font-weight: 600;
      }

      #${SCRIPT_ID}-body {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }

      .${SCRIPT_ID}-pane {
        position: absolute;
        inset: 0;
        box-sizing: border-box;
        display: none;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
      }

      .${SCRIPT_ID}-pane[data-active='true'] {
        display: block;
      }

      #${SCRIPT_ID}-comments-pane > ytd-comments#comments {
        box-sizing: border-box !important;
        width: 100% !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 8px 12px 24px !important;
      }

      #${SCRIPT_ID}-related-pane > #related,
      #${SCRIPT_ID}-related-pane > ytd-watch-next-secondary-results-renderer#related {
        box-sizing: border-box !important;
        display: block !important;
        width: 100% !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 4px 24px !important;
      }

      .${SCRIPT_ID}-status {
        box-sizing: border-box;
        display: grid;
        min-height: 140px;
        place-content: center;
        gap: 12px;
        padding: 24px;
        color: var(--yt-spec-text-secondary, #606060);
        font: 400 14px/20px Roboto, Arial, sans-serif;
        text-align: center;
      }

      .${SCRIPT_ID}-retry {
        justify-self: center;
        height: 36px;
        padding: 0 16px;
        color: var(--yt-spec-text-primary, #0f0f0f);
        font: 500 14px/36px Roboto, Arial, sans-serif;
        cursor: pointer;
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, .1));
        border: 0;
        border-radius: 18px;
      }

      #${SCRIPT_ID}-toast {
        position: absolute;
        z-index: 5;
        right: 12px;
        bottom: 12px;
        left: 12px;
        box-sizing: border-box;
        padding: 12px 14px;
        color: var(--yt-spec-text-primary-inverse, #fff);
        font: 400 13px/18px Roboto, Arial, sans-serif;
        pointer-events: none;
        background: rgba(30, 30, 30, .94);
        border-radius: 8px;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity .18s ease, transform .18s ease;
      }

      #${SCRIPT_ID}-toast[data-visible='true'] {
        opacity: 1;
        transform: translateY(0);
      }

      @media (max-width: ${MIN_VIEWPORT_WIDTH - 1}px) {
        #${SCRIPT_ID}-root {
          display: none !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function readVideoId() {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  function currentWatch() {
    const watches = [...document.querySelectorAll(SELECTORS.watch)];
    return watches.find((watch) => !watch.hidden && watch.getClientRects().length > 0) || watches.at(-1) || null;
  }

  function isWatchPage() {
    return location.pathname === '/watch' && Boolean(readVideoId());
  }

  function watchMatchesUrl(watch) {
    const urlVideoId = readVideoId();
    const domVideoId = watch?.getAttribute('video-id');
    return Boolean(urlVideoId && domVideoId && urlVideoId === domVideoId);
  }

  function isTheaterOrFullscreen(watch) {
    return Boolean(
      document.fullscreenElement ||
      watch?.hasAttribute('theater') ||
      watch?.hasAttribute('fullscreen') ||
      watch?.hasAttribute('full-bleed-player') ||
      watch?.hasAttribute('miniplayer') ||
      document.querySelector('ytd-miniplayer[active]')
    );
  }

  function isTwoColumnLayout(watch) {
    if (!watch || innerWidth < MIN_VIEWPORT_WIDTH) return false;

    const primary = watch.querySelector(SELECTORS.primary);
    const secondary = watch.querySelector(SELECTORS.secondary);
    if (!primary || !secondary) return false;

    const primaryRect = primary.getBoundingClientRect();
    const secondaryRect = secondary.getBoundingClientRect();
    if (primaryRect.width < 1 || secondaryRect.width < 280) return false;

    return secondaryRect.left >= primaryRect.right - 16;
  }

  function isEligible(watch) {
    return isWatchPage() && watchMatchesUrl(watch) && isTwoColumnLayout(watch) && !isTheaterOrFullscreen(watch);
  }

  function marker(name) {
    return document.createComment(`${SCRIPT_ID}:${name}`);
  }

  function statusElement(kind) {
    const text = labels();
    const box = document.createElement('div');
    box.className = `${SCRIPT_ID}-status`;
    box.dataset.kind = kind;

    const message = document.createElement('div');
    message.textContent = kind === 'error' ? text.loadFailed : text.loading;
    box.appendChild(message);

    if (kind === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = `${SCRIPT_ID}-retry`;
      retry.textContent = text.retry;
      retry.addEventListener('click', retryComments);
      box.appendChild(retry);
    }
    return box;
  }

  function setCommentsStatus(kind) {
    if (!state.commentsPane) return;
    state.commentsPane.querySelectorAll(`:scope > .${SCRIPT_ID}-status`).forEach((node) => node.remove());
    if (kind) state.commentsPane.prepend(statusElement(kind));
  }

  function buildRoot() {
    const text = labels();
    const root = document.createElement('section');
    root.id = `${SCRIPT_ID}-root`;
    root.setAttribute('aria-label', `${text.comments} / ${text.related}`);

    const tabs = document.createElement('div');
    tabs.id = `${SCRIPT_ID}-tabs`;
    tabs.setAttribute('role', 'tablist');

    for (const tabName of ['comments', 'related']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `${SCRIPT_ID}-tab`;
      button.dataset.tab = tabName;
      button.id = `${SCRIPT_ID}-${tabName}-tab`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `${SCRIPT_ID}-${tabName}-pane`);
      button.textContent = text[tabName];
      button.addEventListener('click', () => switchTab(tabName));
      tabs.appendChild(button);
    }

    const body = document.createElement('div');
    body.id = `${SCRIPT_ID}-body`;

    const commentsPane = document.createElement('div');
    commentsPane.id = `${SCRIPT_ID}-comments-pane`;
    commentsPane.className = `${SCRIPT_ID}-pane`;
    commentsPane.dataset.tab = 'comments';
    commentsPane.setAttribute('role', 'tabpanel');
    commentsPane.setAttribute('aria-labelledby', `${SCRIPT_ID}-comments-tab`);
    commentsPane.addEventListener('scroll', () => {
      if (state.activeTab === 'comments') state.scrollTop.comments = commentsPane.scrollTop;
    }, { passive: true });

    const relatedPane = document.createElement('div');
    relatedPane.id = `${SCRIPT_ID}-related-pane`;
    relatedPane.className = `${SCRIPT_ID}-pane`;
    relatedPane.dataset.tab = 'related';
    relatedPane.setAttribute('role', 'tabpanel');
    relatedPane.setAttribute('aria-labelledby', `${SCRIPT_ID}-related-tab`);
    relatedPane.addEventListener('scroll', () => {
      if (state.activeTab === 'related') state.scrollTop.related = relatedPane.scrollTop;
    }, { passive: true });

    const toast = document.createElement('div');
    toast.id = `${SCRIPT_ID}-toast`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    body.append(commentsPane, relatedPane, toast);
    root.append(tabs, body);

    state.root = root;
    state.commentsPane = commentsPane;
    state.relatedPane = relatedPane;
    setCommentsStatus('loading');
    return root;
  }

  function refreshLabels() {
    if (!state.root) return;
    const text = labels();
    const commentsTab = state.root.querySelector(`[data-tab='comments'].${SCRIPT_ID}-tab`);
    const relatedTab = state.root.querySelector(`[data-tab='related'].${SCRIPT_ID}-tab`);
    if (commentsTab) commentsTab.textContent = text.comments;
    if (relatedTab) relatedTab.textContent = text.related;
    state.root.setAttribute('aria-label', `${text.comments} / ${text.related}`);
  }

  function switchTab(tabName, options = {}) {
    if (!state.root || !['comments', 'related'].includes(tabName)) return;

    const previousPane = tabName === 'comments' ? state.relatedPane : state.commentsPane;
    if (previousPane && state.activeTab !== tabName) {
      state.scrollTop[state.activeTab] = previousPane.scrollTop;
    }

    state.activeTab = tabName;
    state.root.querySelectorAll(`.${SCRIPT_ID}-tab`).forEach((button) => {
      const selected = button.dataset.tab === tabName;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    state.root.querySelectorAll(`.${SCRIPT_ID}-pane`).forEach((pane) => {
      pane.dataset.active = String(pane.dataset.tab === tabName);
    });

    const activePane = tabName === 'comments' ? state.commentsPane : state.relatedPane;
    requestAnimationFrame(() => {
      if (!activePane) return;
      activePane.scrollTop = options.reset ? 0 : state.scrollTop[tabName];
      activePane.dispatchEvent(new Event('scroll'));
    });
  }

  function showToast(message) {
    const toast = state.root?.querySelector(`#${SCRIPT_ID}-toast`);
    if (!toast) return;
    clearTimeout(state.retryTimer);
    toast.textContent = message;
    toast.dataset.visible = 'true';
    state.retryTimer = window.setTimeout(() => {
      toast.dataset.visible = 'false';
    }, 4_500);
  }

  function commentsUnavailable(node) {
    const message = node?.querySelector('ytd-message-renderer, #message');
    if (!message) return false;
    const value = (message.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return [
      'comments are turned off',
      'comments are disabled',
      'comments are unavailable',
      '댓글이 사용 중지',
      '댓글을 사용할 수 없',
      '댓글이 꺼져',
    ].some((needle) => value.includes(needle));
  }

  function observeComments() {
    state.commentsObserver?.disconnect();
    if (!state.commentsNode) return;

    const check = () => {
      if (!state.commentsNode || state.videoId !== readVideoId()) return;
      if (commentsUnavailable(state.commentsNode)) {
        state.commentsReady = true;
        clearTimeout(state.commentsTimeout);
        setCommentsStatus(null);
        showToast(labels().unavailable);
        window.setTimeout(() => {
          if (state.videoId === readVideoId()) switchTab('related');
        }, 900);
        return;
      }

      if (commentsHaveLoaded(state.commentsNode)) {
        state.commentsReady = true;
        clearTimeout(state.commentsTimeout);
        setCommentsStatus(null);
      }
    };

    state.commentsObserver = new MutationObserver(check);
    state.commentsObserver.observe(state.commentsNode, { childList: true, subtree: true });
    check();
  }

  function commentsHaveLoaded(node) {
    if (!node) return false;
    return Boolean(node.querySelector(
      'ytd-comments-header-renderer, ytd-comment-thread-renderer, ytd-message-renderer, #header #count'
    ));
  }

  function findNativeComments(watch) {
    if (!watch) return null;
    const candidates = [...watch.querySelectorAll(SELECTORS.comments)];
    return candidates.find((node) => !node.closest(`#${SCRIPT_ID}-root`) && node.closest(SELECTORS.primary)) || null;
  }

  function attachComments(generation) {
    if (generation !== state.generation || !state.root?.isConnected) return true;
    if (state.commentsNode) return state.commentsReady;
    const comments = findNativeComments(state.watch);
    if (!comments) return false;

    state.commentsMarker = marker('comments-home');
    comments.parentNode.insertBefore(state.commentsMarker, comments);
    state.commentsPane.appendChild(comments);
    state.commentsNode = comments;
    observeComments();

    requestAnimationFrame(() => {
      state.commentsPane?.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
    });
    return state.commentsReady;
  }

  function waitForComments(generation, startedAt = performance.now()) {
    clearTimeout(state.commentsTimeout);
    if (attachComments(generation) || state.commentsReady) return;
    if (generation !== state.generation || !state.root?.isConnected) return;

    if (performance.now() - startedAt >= COMMENTS_WAIT_MS) {
      setCommentsStatus('error');
      return;
    }

    state.commentsTimeout = window.setTimeout(() => waitForComments(generation, startedAt), 300);
  }

  function retryComments() {
    if (!state.root) return;
    setCommentsStatus('loading');
    switchTab('comments');

    if (state.commentsNode) {
      state.commentsPane.scrollTop = Math.max(0, state.commentsPane.scrollHeight - state.commentsPane.clientHeight - 1);
      state.commentsPane.dispatchEvent(new Event('scroll'));
      requestAnimationFrame(() => {
        if (state.commentsPane) state.commentsPane.scrollTop = 0;
      });
    }
    window.dispatchEvent(new Event('scroll'));
    waitForComments(state.generation);
  }

  function detectSpecialPanel() {
    const inner = state.watch?.querySelector(SELECTORS.secondaryInner);
    if (!inner) return null;

    const chat = inner.querySelector('#chat-container ytd-live-chat-frame:not([collapsed]), ytd-live-chat-frame:not([collapsed])');
    if (chat && chat.getClientRects().length > 0) return 'chat';

    const expandedPanels = [...inner.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
    )];
    const systemPanel = expandedPanels.find((panel) => {
      const targetId = panel.getAttribute('target-id') || '';
      return targetId !== 'engagement-panel-comments-section' && panel.getClientRects().length > 0;
    });
    return systemPanel ? 'engagement' : null;
  }

  function syncSpecialPanel() {
    if (!state.root) return;
    const special = detectSpecialPanel();

    if (special && !state.suspendedBy) {
      state.tabBeforeSpecialPanel = state.activeTab;
      state.suspendedBy = special;
      state.root.dataset.suspended = 'true';
      return;
    }

    if (!special && state.suspendedBy) {
      const previous = state.suspendedBy;
      state.suspendedBy = null;
      state.root.dataset.suspended = 'false';
      switchTab(previous === 'chat' ? 'comments' : state.tabBeforeSpecialPanel);
      return;
    }

    if (special && special !== state.suspendedBy) state.suspendedBy = special;
  }

  function observeSpecialPanels() {
    state.specialObserver?.disconnect();
    const inner = state.watch?.querySelector(SELECTORS.secondaryInner);
    if (!inner) return;
    state.specialObserver = new MutationObserver(() => requestAnimationFrame(syncSpecialPanel));
    state.specialObserver.observe(inner, {
      attributes: true,
      attributeFilter: ['visibility', 'hidden', 'collapsed'],
      childList: true,
      subtree: true,
    });
    syncSpecialPanel();
  }

  function findNativeRelated(watch) {
    const secondaryInner = watch?.querySelector(SELECTORS.secondaryInner);
    if (!secondaryInner) return null;
    return [...secondaryInner.children].find((child) => (
      child.id === 'related' || child.matches('ytd-watch-next-secondary-results-renderer#related')
    )) || null;
  }

  function syncReplacedRelated() {
    if (!state.root?.isConnected || !state.relatedPane) return;
    const replacement = findNativeRelated(state.watch);
    if (!replacement) return;

    const savedScrollTop = state.activeTab === 'related'
      ? state.relatedPane.scrollTop
      : state.scrollTop.related;

    if (state.relatedNode !== replacement && state.relatedNode?.parentElement === state.relatedPane) {
      state.relatedNode.remove();
    }

    state.relatedPane.appendChild(replacement);
    state.relatedNode = replacement;
    state.scrollTop.related = savedScrollTop;

    requestAnimationFrame(() => {
      if (state.activeTab === 'related' && state.relatedPane) {
        state.relatedPane.scrollTop = savedScrollTop;
      }
    });
  }

  function mount(watch) {
    if (!isEligible(watch) || state.root?.isConnected) return;

    const secondaryInner = watch.querySelector(SELECTORS.secondaryInner);
    const related = findNativeRelated(watch);
    if (!secondaryInner || !related) return;

    state.generation += 1;
    const generation = state.generation;
    state.watch = watch;
    state.videoId = readVideoId();
    state.activeTab = 'comments';
    state.scrollTop = { comments: 0, related: 0 };
    state.commentsReady = false;
    state.suspendedBy = null;
    state.tabBeforeSpecialPanel = 'comments';

    const root = buildRoot();
    state.relatedMarker = marker('related-home');
    related.parentNode.insertBefore(state.relatedMarker, related);
    related.parentNode.insertBefore(root, related);
    state.relatedPane.appendChild(related);
    state.relatedNode = related;

    document.documentElement.classList.add(`${SCRIPT_ID}-active`);
    switchTab('comments', { reset: true });
    observeSpecialPanels();
    waitForComments(generation);
  }

  function restoreNode(node, homeMarker) {
    if (!node || !homeMarker?.isConnected) return;
    homeMarker.replaceWith(node);
  }

  function teardown() {
    clearTimeout(state.mountTimeout);
    clearTimeout(state.commentsTimeout);
    clearTimeout(state.retryTimer);
    state.specialObserver?.disconnect();
    state.commentsObserver?.disconnect();
    state.specialObserver = null;
    state.commentsObserver = null;

    if (state.commentsPane) state.scrollTop.comments = state.commentsPane.scrollTop;
    if (state.relatedPane) state.scrollTop.related = state.relatedPane.scrollTop;
    restoreNode(state.commentsNode, state.commentsMarker);
    restoreNode(state.relatedNode, state.relatedMarker);
    state.root?.remove();
    document.documentElement.classList.remove(`${SCRIPT_ID}-active`);

    state.generation += 1;
    state.root = null;
    state.commentsPane = null;
    state.relatedPane = null;
    state.commentsNode = null;
    state.relatedNode = null;
    state.commentsMarker = null;
    state.relatedMarker = null;
    state.commentsReady = false;
    state.videoId = null;
    state.watch = null;
    state.suspendedBy = null;
  }

  function evaluate() {
    addStyles();
    const watch = currentWatch();
    refreshLabels();

    const nextVideoId = readVideoId();
    const wrongGeneration = state.root && (
      state.watch !== watch ||
      state.videoId !== nextVideoId ||
      !watchMatchesUrl(watch)
    );
    if (wrongGeneration || (state.root && !isEligible(watch))) teardown();

    if (!state.root && isEligible(watch)) mount(watch);
    if (state.root) {
      syncReplacedRelated();
      syncSpecialPanel();
    }
  }

  function scheduleEvaluation(delay = 80) {
    clearTimeout(state.evaluationTimer);
    state.evaluationTimer = window.setTimeout(evaluate, delay);
  }

  function retargetObserver() {
    const target = document.querySelector('ytd-app') || document.documentElement;
    if (!target || target === state.observerTarget) return;
    state.appObserver?.disconnect();
    state.observerTarget = target;
    state.appObserver = new MutationObserver(() => scheduleEvaluation());
    state.appObserver.observe(target, {
      attributes: true,
      attributeFilter: [
        'theater',
        'fullscreen',
        'full-bleed-player',
        'miniplayer',
        'is-two-columns_',
        'video-id',
      ],
      childList: true,
      subtree: true,
    });
  }

  function onNavigateStart() {
    teardown();
    scheduleEvaluation(150);
  }

  function onUrlChanged() {
    const nextVideoId = readVideoId();
    if (state.root && state.videoId !== nextVideoId) teardown();
    scheduleEvaluation(0);
  }

  function boot() {
    addStyles();
    state.appObserver = new MutationObserver(() => {
      retargetObserver();
      scheduleEvaluation();
    });
    state.observerTarget = document.documentElement;
    state.appObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('yt-navigate-start', onNavigateStart, true);
    document.addEventListener('yt-navigate-finish', () => scheduleEvaluation(0), true);
    document.addEventListener('yt-page-data-updated', () => scheduleEvaluation(0), true);
    document.addEventListener('fullscreenchange', () => scheduleEvaluation(0), true);
    window.addEventListener('popstate', onUrlChanged, true);
    window.addEventListener('urlchange', onUrlChanged, true);
    window.addEventListener('resize', () => scheduleEvaluation(180), { passive: true });
    document.addEventListener('DOMContentLoaded', () => {
      retargetObserver();
      scheduleEvaluation(0);
    }, { once: true });

    scheduleEvaluation(0);
  }

  boot();
})();
