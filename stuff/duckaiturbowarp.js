// Duck AI responder (targeting the specific response element)
// Paste into the console on https://duck.ai
(function() {
  if (window.DuckAiTurboWarpResponderSpecificInstalled) return;
  window.DuckAiTurboWarpResponderSpecificInstalled = true;

  const ALLOWED_ORIGIN = 'https://turbowarp.org';
  const TEXTAREA_SELECTOR = 'textarea[name="user-prompt"]';
  // Specific response block selector pieces (from the snippet you provided).
  // We match by the two stable-looking classes that appear in the element.
  const RESPONSE_BLOCK_SELECTOR = 'div.VrBPSncUavA1d7C9kAc5.U_5uJaZtJAYAFWUmk7aU';
  const STABLE_MS = 1500;      // how long the response must be unchanged to be considered final
  const MAX_WAIT_MS = 90000;   // maximum time to wait for a response before giving up
  const POLL_MS = 300;         // fallback poll interval

  // pending map: id -> { origin, sourceWindow, buffer, lastText, lastChangeAt, finalizeTimer, maxTimer, pollInterval, observedBlock }
  const pending = {};

  // Utilities
  function findTextarea() {
    return document.querySelector(TEXTAREA_SELECTOR);
  }

  function setTextareaValue(ta, value) {
    if (!ta) return false;
    ta.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(ta, value);
    else ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    ta.dispatchEvent(new Event('compositionend', { bubbles: true }));
    try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (e) {}
    return true;
  }

  function clickSendOnce() {
    const btn = document.querySelector('button[aria-label="Send"]') ||
                Array.from(document.querySelectorAll('button')).find(b => b.querySelector && b.querySelector('svg'));
    if (!btn) return false;
    try {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    } catch (err) {
      try { btn.click(); return true; } catch (e) { return false; }
    }
  }

  // Extract text from the specific response block. Prefer animated spans in order.
  function extractTextFromResponseBlock(block) {
    if (!block) return '';
    // Prefer the animated spans in document order (these are the fragments that stream in)
    const animated = block.querySelectorAll('span[data-sd-animate], span[data-sd-animate="true"]');
    if (animated && animated.length) {
      const parts = [];
      animated.forEach(sp => {
        const t = (sp.textContent || '').replace(/\s+/g, ' ');
        if (t.trim()) parts.push(t.trim());
      });
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    // Fallback: gather paragraphs and text nodes preserving order
    const paragraphs = Array.from(block.querySelectorAll('p'));
    if (paragraphs.length) {
      return paragraphs.map(p => p.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n').trim();
    }

    // Last resort: block innerText
    return (block.innerText || '').replace(/\s+/g, ' ').trim();
  }

  // Post reply back to the original source
  function postReplyToSource(sourceWindow, origin, id, payload, ok = true, extra = {}) {
    const msg = { type: 'turbowarp-reply', replyTo: id, ok, payload, ...extra };
    try {
      if (sourceWindow && typeof sourceWindow.postMessage === 'function') {
        sourceWindow.postMessage(msg, origin);
      } else if (window.opener && !window.opener.closed) {
        window.opener.postMessage(msg, origin);
      } else {
        console.warn('DuckAiResponderSpecific: no valid target to post reply to for id', id);
      }
    } catch (err) {
      console.error('DuckAiResponderSpecific: postMessage failed', err);
    }
  }

  // Finalize pending id: send final buffer and cleanup
  function finalizePending(id, reason = 'final') {
    const p = pending[id];
    if (!p) return;
    clearInterval(p.pollInterval);
    clearTimeout(p.finalizeTimer);
    clearTimeout(p.maxTimer);
    if (p.observer) {
      try { p.observer.disconnect(); } catch (e) {}
    }
    const text = (p.buffer || '').replace(/\u200B/g, '').trim();
    postReplyToSource(p.sourceWindow, p.origin, id, text, true, { reason });
    delete pending[id];
  }

  // Called when we detect a potential update to the response block for a pending id
  function onResponseBlockChanged(id) {
    const p = pending[id];
    if (!p) return;
    const block = p.observedBlock || findLatestResponseBlock();
    if (!block) return;
    const text = extractTextFromResponseBlock(block);
    if (text === p.lastText) {
      // no change
      return;
    }
    p.lastText = text;
    p.buffer = text;
    p.lastChangeAt = Date.now();

    // reset finalize timer: wait STABLE_MS after last change
    if (p.finalizeTimer) clearTimeout(p.finalizeTimer);
    p.finalizeTimer = setTimeout(() => {
      // double-check that text hasn't changed since timer set
      const now = Date.now();
      if (now - p.lastChangeAt >= STABLE_MS) {
        finalizePending(id, 'stable');
      } else {
        // schedule again if needed
        if (p.finalizeTimer) clearTimeout(p.finalizeTimer);
        p.finalizeTimer = setTimeout(() => finalizePending(id, 'stable'), STABLE_MS);
      }
    }, STABLE_MS + 50);
  }

  // Find the latest response block using the specific selector as primary heuristic
  function findLatestResponseBlock() {
    // Try the specific selector first
    const blocks = Array.from(document.querySelectorAll(RESPONSE_BLOCK_SELECTOR));
    if (blocks.length) return blocks[blocks.length - 1];

    // Fallback: find last element that contains animated spans
    const animatedSpans = Array.from(document.querySelectorAll('span[data-sd-animate], span[data-sd-animate="true"]'));
    if (animatedSpans.length) {
      const lastSpan = animatedSpans[animatedSpans.length - 1];
      return lastSpan.closest('div') || lastSpan.parentElement;
    }

    // Fallback: last paragraph
    const ps = document.querySelectorAll('p');
    if (ps.length) return ps[ps.length - 1].closest('div') || ps[ps.length - 1];
    return null;
  }

  // Observe a specific block for fine-grained changes (used to ensure we wait until streaming finishes)
  function observeBlockForPending(id, block) {
    const p = pending[id];
    if (!p || !block) return;
    p.observedBlock = block;

    // If an observer already exists for this pending, disconnect it
    if (p.observer) {
      try { p.observer.disconnect(); } catch (e) {}
    }

    const obs = new MutationObserver((mutations) => {
      // Any mutation inside the block counts as an update
      for (const m of mutations) {
        // If text changed or nodes added/removed, treat as update
        if (m.type === 'characterData' || m.addedNodes?.length || m.removedNodes?.length || m.type === 'childList') {
          onResponseBlockChanged(id);
          break;
        }
      }
    });

    try {
      obs.observe(block, { childList: true, subtree: true, characterData: true });
      p.observer = obs;
    } catch (err) {
      // If observing fails, rely on polling fallback
      console.warn('DuckAiResponderSpecific: block observer failed, falling back to poll', err);
    }
  }

  // Start a polling fallback for a pending id
  function startPollForPending(id) {
    const p = pending[id];
    if (!p) return;
    if (p.pollInterval) return;
    p.pollInterval = setInterval(() => {
      if (!pending[id]) {
        clearInterval(p.pollInterval);
        return;
      }
      onResponseBlockChanged(id);
    }, POLL_MS);
  }

  // Global MutationObserver to detect new response blocks appearing in the page
  const globalObserver = new MutationObserver((mutations) => {
    if (!Object.keys(pending).length) return;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          // If the added node matches the specific response selector or contains animated spans, treat it as a new block
          if (n.matches && n.matches(RESPONSE_BLOCK_SELECTOR) || n.querySelector && (n.querySelector('span[data-sd-animate]') || n.querySelector('p'))) {
            const ids = Object.keys(pending);
            if (!ids.length) return;
            const id = ids[ids.length - 1]; // map to most recent pending
            const block = n.matches && n.matches(RESPONSE_BLOCK_SELECTOR) ? n : findLatestResponseBlock();
            if (block) observeBlockForPending(id, block);
            onResponseBlockChanged(id);
          }
        }
      }
      if (m.type === 'characterData' && m.target) {
        const parent = m.target.parentElement;
        if (parent && (parent.matches && parent.matches('span[data-sd-animate]'))) {
          const ids = Object.keys(pending);
          if (!ids.length) return;
          const id = ids[ids.length - 1];
          const block = findLatestResponseBlock();
          if (block) observeBlockForPending(id, block);
          onResponseBlockChanged(id);
        }
      }
    }
  });

  try {
    globalObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (err) {
    console.warn('DuckAiResponderSpecific: global observer failed to start', err);
  }

  // Message handler: receives turbowarp-message, fills textarea, optionally clicks send, and registers pending
  window.addEventListener('message', function onMessage(e) {
    try {
      if (e.origin !== ALLOWED_ORIGIN) return;
      const msg = e.data;
      if (!msg || msg.type !== 'turbowarp-message') return;

      const id = msg.id;
      const text = String(msg.text ?? '');
      const autoSend = !!msg.autoSend;

      // Register pending
      pending[id] = pending[id] || {
        origin: e.origin,
        sourceWindow: e.source,
        buffer: '',
        lastText: '',
        lastChangeAt: Date.now(),
        finalizeTimer: null,
        maxTimer: null,
        pollInterval: null,
        observer: null,
        observedBlock: null,
        startedAt: Date.now()
      };

      // Max wait timer
      pending[id].maxTimer = setTimeout(() => {
        const p = pending[id];
        if (!p) return;
        clearInterval(p.pollInterval);
        clearTimeout(p.finalizeTimer);
        if (p.observer) try { p.observer.disconnect(); } catch (e) {}
        const textSoFar = (p.buffer || '').replace(/\u200B/g, '').trim();
        postReplyToSource(p.sourceWindow, p.origin, id, textSoFar, true, { reason: 'max-wait-timeout' });
        delete pending[id];
      }, MAX_WAIT_MS);

      // Fill textarea
      const ta = findTextarea();
      if (!ta) {
        const errReply = { type: 'turbowarp-reply', replyTo: id, ok: false, error: 'textarea-not-found' };
        try { e.source.postMessage(errReply, e.origin); } catch (err) {}
        delete pending[id];
        return;
      }

      const inserted = setTextareaValue(ta, text);

      // If autoSend requested, try to click send and wait for a new response block to appear
      if (autoSend) {
        let clicked = clickSendOnce();
        if (!clicked) {
          // retry loop short
          let attempts = 0;
          const retryId = setInterval(() => {
            attempts++;
            if (clickSendOnce() || attempts >= 10) {
              clearInterval(retryId);
              const ack = { type: 'turbowarp-reply', replyTo: id, ok: true, payload: { inserted, autoSent: autoSend, sendClicked: attempts < 10 } };
              try { e.source.postMessage(ack, e.origin); } catch (err) {}
              // start polling/observing even if send wasn't clicked (maybe user will click)
              const block = findLatestResponseBlock();
              if (block) observeBlockForPending(id, block);
              startPollForPending(id);
            }
          }, 200);
        } else {
          // immediate ack that send was clicked; still wait for response via observer/poll
          const ack = { type: 'turbowarp-reply', replyTo: id, ok: true, payload: { inserted, autoSent: autoSend, sendClicked: true } };
          try { e.source.postMessage(ack, e.origin); } catch (err) {}
          // attempt to find the new response block and observe it
          setTimeout(() => {
            const block = findLatestResponseBlock();
            if (block) observeBlockForPending(id, block);
            startPollForPending(id);
          }, 150);
        }
      } else {
        // If not autoSend, acknowledge insertion
        const ack = { type: 'turbowarp-reply', replyTo: id, ok: true, payload: { inserted, autoSent: false } };
        try { e.source.postMessage(ack, e.origin); } catch (err) {}
        // still start poll in case a response is already present
        setTimeout(() => {
          const block = findLatestResponseBlock();
          if (block) observeBlockForPending(id, block);
          startPollForPending(id);
        }, 150);
      }

      // Trigger an initial check shortly after sending/filling
      setTimeout(() => onResponseBlockChanged(id), 200);

    } catch (err) {
      console.error('DuckAiResponderSpecific: message handler error', err);
    }
  }, false);

  // Expose debug API
  window.DuckAiTurboWarpResponderSpecific = {
    pending,
    extractTextFromResponseBlock,
    finalizePending,
    stop: function() {
      try { globalObserver.disconnect(); } catch (e) {}
      window.removeEventListener('message', onMessage, false);
      Object.keys(pending).forEach(id => {
        try { clearInterval(pending[id].pollInterval); clearTimeout(pending[id].finalizeTimer); clearTimeout(pending[id].maxTimer); if (pending[id].observer) pending[id].observer.disconnect(); } catch(e){}
      });
      delete window.DuckAiTurboWarpResponderSpecificInstalled;
    }
  };

  console.log('DuckAiTurboWarpResponderSpecific installed. Listening for messages from', ALLOWED_ORIGIN);
})();