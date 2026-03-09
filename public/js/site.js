(() => {
  const LOGIN_URL = '/login?redirect=' + encodeURIComponent(window.location.pathname || '/');

  function isLoggedIn() {
    return window.__isLoggedIn === true || window.__isLoggedIn === 'true';
  }

  function getFavorites() {
    if (!isLoggedIn() || !window.__userFavorites) return [];
    return Array.isArray(window.__userFavorites) ? [...window.__userFavorites] : [];
  }

  function setUserFavoritesFromServer(ids) {
    if (!window.__userFavorites || !Array.isArray(ids)) return;
    window.__userFavorites.length = 0;
    window.__userFavorites.push(...ids);
    notifyFavoritesChanged(ids);
  }

  function notifyFavoritesChanged(ids) {
    try {
      const detail = { ids: ids || getFavorites() };
      window.dispatchEvent(new CustomEvent('favorites:changed', { detail }));
    } catch {
      // Fail silently
    }
  }

  function updateFavoriteButtons() {
    const favs = new Set(getFavorites());
    document.querySelectorAll('.favorite-btn[data-favorite-id]').forEach((btn) => {
      const id = btn.getAttribute('data-favorite-id');
      const isFav = favs.has(id);
      const loggedIn = isLoggedIn();
      btn.classList.toggle('is-favorited', isFav);
      btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
      btn.disabled = !loggedIn;
      if (!loggedIn) btn.setAttribute('title', 'Log in to add to favorites');

      const icon = btn.querySelector('i');
      if (icon) {
        icon.classList.toggle('fa-regular', !isFav);
        icon.classList.toggle('fa-solid', isFav);
      }

      const label = btn.querySelector('.favorite-btn-label') || btn.querySelector('span:not(.badge)');
      if (label) {
        const globalCount = btn.getAttribute('data-global-fav') || '0';
        if (loggedIn) {
          label.textContent = isFav ? `Saved (${globalCount})` : `Save (${globalCount})`;
        } else {
          label.textContent = 'Log in to save';
        }
      }
    });
  }

  // --- RATINGS (login required) ---
  async function submitRatingApi(attractionId, value) {
    try {
      const resp = await fetch(`/api/rate/${attractionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: value })
      });
      if (resp.status === 401) {
        const data = await resp.json().catch(() => ({}));
        if (data.loginRequired) window.location.href = LOGIN_URL;
        return null;
      }
      return await resp.json();
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function setRating(attractionId, value) {
    if (!isLoggedIn()) {
      window.location.href = LOGIN_URL;
      return;
    }
    if (typeof window.showProcessLoader === 'function') window.showProcessLoader('Saving rating...');
    updateRatingUI(attractionId, value, null);
    const stats = await submitRatingApi(attractionId, value);
    if (typeof window.hideProcessLoader === 'function') window.hideProcessLoader();
    if (stats) {
      updateRatingUI(attractionId, value, stats);
      if (window.__userRatings) window.__userRatings[attractionId] = value;
      if (window.showToast) window.showToast('Rating saved!', 'success');
    }
  }

  function updateRatingUI(attractionId, value, stats) {
    const container = document.querySelector(`.rating-container[data-id="${attractionId}"]`);
    if (!container) return;

    if (value) {
      const stars = container.querySelectorAll('.rating-star');
      stars.forEach((star, index) => {
        if (index < value) {
          star.classList.replace('fa-regular', 'fa-solid');
          star.classList.add('text-warning');
        } else {
          star.classList.replace('fa-solid', 'fa-regular');
          star.classList.remove('text-warning');
        }
      });
    }

    const label = container.querySelector('.rating-label');
    if (label && stats) {
      label.textContent = `${stats.avgRating} / 5 (${stats.ratingCount} reviews)`;
    } else if (label && value) {
      label.textContent = 'Saving...';
    }
  }

  function initRatings() {
    if (!window.__userRatings || typeof window.__userRatings !== 'object') return;
    document.querySelectorAll('.rating-container[data-id]').forEach((container) => {
      const id = container.getAttribute('data-id');
      const value = window.__userRatings[id];
      if (value) updateRatingUI(id, value, null);
    });
  }

  function wireRatingClicks() {
    document.addEventListener('click', (e) => {
      const star = e.target.closest('.rating-star');
      if (!star) return;

      const container = star.closest('.rating-container');
      const attractionId = container.getAttribute('data-id');
      const value = parseInt(star.getAttribute('data-value'), 10);

      setRating(attractionId, value);
    });
  }

  function hidePageLoader() {
    const el = document.getElementById('pageLoader');
    if (!el) return;
    el.classList.add('hidden');
  }

  async function toggleFavoriteApi(id, action) {
    try {
      const resp = await fetch(`/api/favorite/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (resp.status === 401) {
        const data = await resp.json().catch(() => ({}));
        if (data.loginRequired) window.location.href = LOGIN_URL;
        return null;
      }
      return await resp.json();
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  function wireFavoriteClicks() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.favorite-btn[data-favorite-id]');
      if (!btn) return;
      if (!isLoggedIn()) {
        window.location.href = LOGIN_URL;
        return;
      }
      const id = btn.getAttribute('data-favorite-id');
      const favs = getFavorites();
      const isAdding = !favs.includes(id);
      const loaderMsg = isAdding ? 'Adding to favorites' : 'Removing from favorites';
      if (typeof window.showProcessLoader === 'function') window.showProcessLoader(loaderMsg);
      const next = isAdding ? [...favs, id] : favs.filter((x) => x !== id);
      setUserFavoritesFromServer(next);
      updateFavoriteButtons();

      const stats = await toggleFavoriteApi(id, isAdding ? 'add' : 'remove');
      if (typeof window.hideProcessLoader === 'function') window.hideProcessLoader();
      if (stats) {
        document.querySelectorAll(`.favorite-btn[data-favorite-id="${id}"]`).forEach((b) => {
          b.setAttribute('data-global-fav', stats.favoritesCount);
        });
        updateFavoriteButtons();
        if (window.showToast) window.showToast(isAdding ? 'Added to favorites!' : 'Removed from favorites!', 'success');
      } else {
        setUserFavoritesFromServer(favs);
        updateFavoriteButtons();
        if (window.showToast) window.showToast('Could not update favorites. Try again.', 'error');
      }
    });
  }

  function init() {
    hidePageLoader();
    updateFavoriteButtons();
    wireFavoriteClicks();
    initRatings();
    wireRatingClicks();
    initScrollReveal();
    initCounterAnimations();
    initSmoothNavLinks();
    initBackToTop();
    initPasswordToggles();
  }

  // --- Counter animations for stat numbers ---
  function initCounterAnimations() {
    var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var counters = document.querySelectorAll('.stat-number[data-count]');
    if (!counters.length || prefersReduced) return;

    if (!('IntersectionObserver' in window)) {
      counters.forEach(function(el) { el.textContent = el.getAttribute('data-count'); });
      return;
    }

    var observer = new IntersectionObserver(function(entries, obs) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        obs.unobserve(el);
        var target = parseInt(el.getAttribute('data-count'), 10) || 0;
        var duration = 1500;
        var start = performance.now();

        function step(now) {
          var progress = Math.min((now - start) / duration, 1);
          // Ease out cubic
          var eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(eased * target).toLocaleString();
          if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
    }, { threshold: 0.3 });

    counters.forEach(function(el) { observer.observe(el); });
  }

  // --- Smooth scroll for anchor links ---
  function initSmoothNavLinks() {    document.querySelectorAll('a[href^="#"]').forEach(function(link) {
      link.addEventListener('click', function(e) {
        var target = document.querySelector(this.getAttribute('href'));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  // --- Scroll reveal animations ---
  function initScrollReveal() {
    var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var elements = document.querySelectorAll('.reveal-on-scroll');
    if (!elements.length) return;

    // If user prefers reduced motion or no IntersectionObserver, show everything
    if (prefersReduced || !('IntersectionObserver' in window)) {
      elements.forEach(function(el) { el.classList.add('is-visible'); });
      return;
    }

    // Auto-stagger sibling cards (e.g. .col-md-4 items in a .row)
    document.querySelectorAll('.row').forEach(function(row) {
      var children = row.querySelectorAll(':scope > .reveal-on-scroll');
      children.forEach(function(child, i) {
        if (!child.getAttribute('data-reveal-delay')) {
          child.setAttribute('data-reveal-delay', (i * 0.1) + 's');
        }
      });
    });

    var observer = new IntersectionObserver(
      function(entries, obs) {
        entries.forEach(function(entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;

          // Optional per-element delay using data-reveal-delay
          var delay = el.getAttribute('data-reveal-delay');
          if (delay) {
            el.style.setProperty('--reveal-delay', delay);
          }

          el.classList.add('is-visible');
          obs.unobserve(el);
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px -40px 0px',
      }
    );

    elements.forEach(function(el) { observer.observe(el); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // --- Back to top button ---
  function initBackToTop() {
    var btn = document.getElementById('backToTop');
    if (!btn) return;
    window.addEventListener('scroll', function() {
      btn.classList.toggle('visible', window.scrollY > 400);
    }, { passive: true });
    btn.addEventListener('click', function() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // --- Toast notifications ---
  window.showToast = function(message, type) {
    type = type || 'info';
    var stack = document.getElementById('toastStack');
    if (!stack) return;
    var icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    var iconClass = icons[type] || icons.info;
    var t = document.createElement('div');
    t.className = 'toast-custom';
    t.setAttribute('role', 'status');
    t.innerHTML = '<i class="fas ' + iconClass + ' toast-icon-' + type + '" aria-hidden="true"></i><span>' +
      String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
    stack.appendChild(t);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { t.classList.add('show'); });
    });
    setTimeout(function() {
      t.classList.remove('show');
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 350);
    }, 3000);
  };

  // --- Password show/hide toggles ---
  function initPasswordToggles() {
    document.querySelectorAll('.btn-pw-toggle').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var input = btn.previousElementSibling;
        if (!input || (input.type !== 'password' && input.type !== 'text')) return;
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        var icon = btn.querySelector('i');
        if (icon) {
          icon.classList.toggle('fa-eye', showing);
          icon.classList.toggle('fa-eye-slash', !showing);
        }
        btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      });
    });
  }
})();
