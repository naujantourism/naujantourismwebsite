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
      } else {
        setUserFavoritesFromServer(favs);
        updateFavoriteButtons();
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
  }

  // --- Scroll reveal animations ---
  function initScrollReveal() {
    const elements = document.querySelectorAll('.reveal-on-scroll');
    if (!elements.length) return;

    // Fallback: if IntersectionObserver is not supported, just show everything
    if (!('IntersectionObserver' in window)) {
      elements.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;

          // Optional per-element delay using data-reveal-delay
          const delay = el.getAttribute('data-reveal-delay');
          if (delay) {
            el.style.setProperty('--reveal-delay', delay);
          }

          el.classList.add('is-visible');
          obs.unobserve(el);
        });
      },
      {
        threshold: 0.15,
      }
    );

    elements.forEach((el) => observer.observe(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
