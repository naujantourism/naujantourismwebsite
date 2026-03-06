/**
 * App-themed modal API (replaces native confirm, alert, prompt).
 * Use appConfirm(), appAlert(), appPrompt() so dialogs match the site style.
 */
(function () {
    function getModal() {
        var el = document.getElementById('appModal');
        if (!el) return null;
        return typeof bootstrap !== 'undefined' ? bootstrap.Modal.getOrCreateInstance(el) : null;
    }

    function getElements() {
        return {
            message: document.getElementById('appModalMessage'),
            promptWrap: document.getElementById('appModalPromptWrap'),
            input: document.getElementById('appModalInput'),
            btnOk: document.getElementById('appModalOk'),
            btnCancel: document.getElementById('appModalCancel')
        };
    }

    function showModal(opts) {
        var modal = getModal();
        var el = document.getElementById('appModal');
        if (!el || !modal) return;

        var els = getElements();
        if (!els.message) return;

        var mode = opts.mode || 'confirm'; // 'confirm' | 'alert' | 'prompt'
        var message = opts.message || '';
        var defaultValue = opts.defaultValue != null ? String(opts.defaultValue) : '';
        var onOk = typeof opts.onOk === 'function' ? opts.onOk : function () {};
        var onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : function () {};

        els.message.textContent = message;
        els.promptWrap.classList.toggle('d-none', mode !== 'prompt');
        els.btnCancel.style.display = mode === 'alert' ? 'none' : '';

        if (mode === 'prompt') {
            els.input.value = defaultValue;
            els.input.placeholder = opts.placeholder || '';
        }

        var resolved = false;
        function cleanup() {
            els.btnOk.onclick = null;
            els.btnCancel.onclick = null;
            els.input.onkeydown = null;
        }

        function doOk() {
            if (resolved) return;
            resolved = true;
            cleanup();
            el.removeEventListener('hidden.bs.modal', onHidden);
            modal.hide();
            if (mode === 'prompt') {
                onOk(els.input.value);
            } else {
                onOk();
            }
        }

        function doCancel() {
            if (resolved) return;
            resolved = true;
            cleanup();
            el.removeEventListener('hidden.bs.modal', onHidden);
            modal.hide();
            if (mode === 'prompt') onCancel();
            else onCancel();
        }

        function onHidden() {
            if (!resolved) {
                resolved = true;
                cleanup();
                if (mode !== 'alert') onCancel();
            }
        }

        el.addEventListener('hidden.bs.modal', onHidden, { once: true });

        els.btnOk.onclick = function () {
            doOk();
        };

        els.btnCancel.onclick = function () {
            doCancel();
        };

        if (mode === 'prompt') {
            els.input.onkeydown = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    doOk();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    doCancel();
                }
            };
            setTimeout(function () {
                if (els.input && els.input.offsetParent) els.input.focus();
            }, 100);
        }

        modal.show();
    }

    window.appConfirm = function (message, onOk, onCancel) {
        showModal({
            mode: 'confirm',
            message: message,
            onOk: onOk || function () {},
            onCancel: onCancel || function () {}
        });
    };

    window.appAlert = function (message, onOk) {
        showModal({
            mode: 'alert',
            message: message,
            onOk: onOk || function () {}
        });
    };

    window.appPrompt = function (message, defaultValue, onOk, onCancel) {
        showModal({
            mode: 'prompt',
            message: message,
            defaultValue: defaultValue != null ? defaultValue : '',
            onOk: onOk || function () {},
            onCancel: onCancel || function () {}
        });
    };
})();
