// Shared page behaviour: mobile menu, sticky header, tabs, carousels,
// scroll reveals and the click-to-load video.

// Mobile menu
(function () {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.getElementById('site-nav');
    if (!toggle || !nav) return;

    function setOpen(open) {
        nav.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Close' : 'Menu';
    }

    toggle.addEventListener('click', function () {
        setOpen(!nav.classList.contains('is-open'));
    });
    nav.addEventListener('click', function (event) {
        if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && nav.classList.contains('is-open')) {
            setOpen(false);
            toggle.focus();
        }
    });
})();

// Header gets a border once the page scrolls
(function () {
    const header = document.querySelector('.site-header');
    if (!header) return;
    function update() {
        header.classList.toggle('is-scrolled', window.scrollY > 8);
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
})();

// Tabs: <div role="tablist"> with buttons whose aria-controls names a panel
(function () {
    document.querySelectorAll('[role="tablist"]').forEach(function (list) {
        const tabs = Array.from(list.querySelectorAll('[role="tab"]'));

        function select(tab, focus) {
            tabs.forEach(function (other) {
                const selected = other === tab;
                other.setAttribute('aria-selected', String(selected));
                other.tabIndex = selected ? 0 : -1;
                document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
            });
            if (focus) tab.focus();
        }

        tabs.forEach(function (tab, index) {
            tab.addEventListener('click', function () {
                select(tab, false);
            });
            tab.addEventListener('keydown', function (event) {
                let next = null;
                if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
                if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
                if (event.key === 'Home') next = tabs[0];
                if (event.key === 'End') next = tabs[tabs.length - 1];
                if (next) {
                    event.preventDefault();
                    select(next, true);
                }
            });
        });
    });
})();

// Carousels: a scrolling list plus previous/next buttons
(function () {
    document.querySelectorAll('[data-carousel]').forEach(function (track) {
        const controls = document.querySelector(`[data-carousel-controls="${track.id}"]`);
        if (!controls) return;
        const prev = controls.querySelector('[data-dir="prev"]');
        const next = controls.querySelector('[data-dir="next"]');

        function step() {
            const item = track.firstElementChild;
            const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
            return item ? item.getBoundingClientRect().width + gap : track.clientWidth;
        }
        function update() {
            const max = track.scrollWidth - track.clientWidth - 2;
            prev.disabled = track.scrollLeft <= 2;
            next.disabled = track.scrollLeft >= max;
            controls.hidden = track.scrollWidth <= track.clientWidth + 2;
        }

        prev.addEventListener('click', function () {
            track.scrollBy({ left: -step(), behavior: 'smooth' });
        });
        next.addEventListener('click', function () {
            track.scrollBy({ left: step(), behavior: 'smooth' });
        });
        track.addEventListener('scroll', update, { passive: true });
        if ('ResizeObserver' in window) {
            new ResizeObserver(update).observe(track);
        } else {
            window.addEventListener('resize', update);
        }
        update();
    });
})();

// Reveal sections as they scroll into view
(function () {
    const items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
        items.forEach(function (item) {
            item.classList.add('is-visible');
        });
        return;
    }
    const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
        });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (item) {
        observer.observe(item);
    });
})();

// YouTube loads only when someone presses play
(function () {
    document.querySelectorAll('[data-video-id]').forEach(function (button) {
        button.addEventListener('click', function () {
            const frame = document.createElement('iframe');
            frame.className = 'video-frame';
            frame.src = `https://www.youtube-nocookie.com/embed/${button.dataset.videoId}?autoplay=1&rel=0`;
            frame.title = button.dataset.videoTitle || 'Video';
            frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture';
            frame.allowFullscreen = true;
            button.replaceWith(frame);
        });
    });
})();
