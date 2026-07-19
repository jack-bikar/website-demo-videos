/**
 * Scripts injected into every recorded page. These run in the browser, are serialized by
 * puppeteer, and must stay dependency-free ES5-ish functions.
 */

/**
 * Draws a visible mouse cursor in-page. The CDP screencast does NOT capture the OS cursor,
 * so we render our own: an arrow that follows the synthesized mouse moves, plus a soft
 * ripple on each click. Lives on <html> so SPA re-renders of <body> don't remove it.
 */
export function installCursor(): void {
  var ID = '__demoCursor__';
  function install() {
    if (!document.documentElement || document.getElementById(ID)) return;
    var c = document.createElement('div');
    c.id = ID;
    // Visible from the start; Node seats it at a natural resting spot (off the corner) before the
    // recording begins, then it follows the synthesized mouse moves.
    c.style.cssText =
      'position:fixed;left:-100px;top:-100px;width:44px;height:44px;z-index:2147483647;pointer-events:none;' +
      'transition:left .07s linear,top .07s linear;' +
      'filter:drop-shadow(0 3px 6px rgba(0,0,0,.55));';
    c.innerHTML =
      '<svg width="44" height="44" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 3l14 7-5.5 1.6L10 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    var move = function (x: number, y: number) {
      c.style.left = x + 'px';
      c.style.top = y + 'px';
    };
    document.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); }, true);
    document.addEventListener('mousedown', function (e) {
      c.style.filter = 'drop-shadow(0 3px 6px rgba(0,0,0,.55)) brightness(0.85)';
      setTimeout(function () { c.style.filter = 'drop-shadow(0 3px 6px rgba(0,0,0,.55))'; }, 160);
      var r = document.createElement('div');
      r.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;' +
        'left:' + (e.clientX - 16) + 'px;top:' + (e.clientY - 16) + 'px;width:32px;height:32px;' +
        'background:rgba(56,132,255,.5);border:3px solid rgba(56,132,255,1);' +
        'box-shadow:0 0 18px rgba(56,132,255,.6);' +
        'transition:transform .5s ease-out,opacity .5s ease-out;';
      document.documentElement.appendChild(r);
      requestAnimationFrame(function () { r.style.transform = 'scale(3.5)'; r.style.opacity = '0'; });
      setTimeout(function () { r.remove(); }, 550);
    }, true);

    // Node hook to seat the cursor at a position with no visible streak (used at start / after nav).
    (window as any).__demoCursor = {
      move: move,
      place: function (x: number, y: number) {
        var prev = c.style.transition;
        c.style.transition = 'none'; // jump with no visible streak
        move(x, y);
        void c.offsetWidth; // force reflow so 'none' applies before we restore the transition
        c.style.transition = prev;
      },
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  install();
  setTimeout(install, 400);
}

/**
 * Removes known non-demo page furniture (for example a staging disclaimer) before it appears
 * in the screencast. Text matching is exact after whitespace normalization.
 */
export function installTextHider(hiddenText: string[]): void {
  var needles = Array.isArray(hiddenText)
    ? hiddenText
        .map(function (t) {
          return String(t || '').replace(/\s+/g, ' ').trim();
        })
        .filter(Boolean)
    : [];
  if (!needles.length || (window as any).__demoTextHiderInstalled) return;
  (window as any).__demoTextHiderInstalled = true;

  function normalize(value: unknown) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function removeMatches() {
    if (!document.body) return;
    var all = Array.prototype.slice.call(document.body.querySelectorAll('*'));
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el || !el.parentElement || el === document.body || el === document.documentElement) continue;
      if (needles.indexOf(normalize(el.textContent)) !== -1) {
        el.remove();
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', removeMatches);
  removeMatches();
  new MutationObserver(removeMatches).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
