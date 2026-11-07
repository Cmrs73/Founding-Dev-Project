(function () {
    const VIEWER_SRC = 'https://cdn.spline.design/@splinetool/viewer@2.0.134/build/spline-viewer.js';

    const visual = document.getElementById('hero-visual');
    const canvas = document.getElementById('hero-canvas');
    const ctx = canvas.getContext('2d');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // A rotating globe of points, with app tiles travelling on tilted orbits.
    const POINT_COUNT = 900;
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    const points = [];
    for (let i = 0; i < POINT_COUNT; i++) {
        const y = 1 - (i / (POINT_COUNT - 1)) * 2;
        const radius = Math.sqrt(1 - y * y);
        const angle = i * GOLDEN_ANGLE;
        points.push({ x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius });
    }

    const orbits = [
        { radius: 1.32, tilt: 0.42, roll: -0.35, speed: 0.34, packets: [0, 2.4, 4.3] },
        { radius: 1.52, tilt: 1.12, roll: 0.5, speed: -0.22, packets: [1, 3.8] },
    ];

    let width = 0;
    let height = 0;
    let animationId = null;
    let isVisible = true;
    let splineReady = false;
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };

    function orbitPoint(orbit, angle) {
        const x = Math.cos(angle) * orbit.radius;
        const z = Math.sin(angle) * orbit.radius;
        const y = -z * Math.sin(orbit.tilt);
        const depth = z * Math.cos(orbit.tilt);
        return {
            x: x * Math.cos(orbit.roll) - y * Math.sin(orbit.roll),
            y: x * Math.sin(orbit.roll) + y * Math.cos(orbit.roll),
            z: depth,
        };
    }

    function drawOrbit(orbit, scale, cx, cy, time, front) {
        const steps = 120;
        for (let i = 0; i < steps; i++) {
            const a = orbitPoint(orbit, (i / steps) * Math.PI * 2);
            const b = orbitPoint(orbit, ((i + 1) / steps) * Math.PI * 2);
            if (a.z >= 0 !== front) continue;
            ctx.beginPath();
            ctx.moveTo(cx + a.x * scale, cy + a.y * scale);
            ctx.lineTo(cx + b.x * scale, cy + b.y * scale);
            ctx.strokeStyle = front ? 'rgba(201, 166, 255, 0.34)' : 'rgba(201, 166, 255, 0.1)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        orbit.packets.forEach(function (offset) {
            const p = orbitPoint(orbit, offset + time * orbit.speed);
            if (p.z >= 0 !== front) return;
            const px = cx + p.x * scale;
            const py = cy + p.y * scale;
            const size = Math.max(4, scale * 0.034) * (front ? 1 : 0.7);
            ctx.globalAlpha = front ? 1 : 0.35;

            // Each packet is a small app tile with a window bar.
            ctx.save();
            ctx.translate(px, py);
            ctx.shadowColor = '#b98cff';
            ctx.shadowBlur = size * 3;
            ctx.fillStyle = '#f4edff';
            ctx.beginPath();
            // roundRect is missing on older Safari (before iOS 16), so fall back to a square.
            if (ctx.roundRect) {
                ctx.roundRect(-size, -size, size * 2, size * 2, size * 0.4);
            } else {
                ctx.rect(-size, -size, size * 2, size * 2);
            }
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(-size, -size * 0.35);
            ctx.lineTo(size, -size * 0.35);
            ctx.strokeStyle = '#6600c5';
            ctx.lineWidth = Math.max(1, size * 0.2);
            ctx.stroke();
            ctx.restore();
            ctx.globalAlpha = 1;
        });
    }

    function draw(time) {
        ctx.clearRect(0, 0, width, height);
        const cx = width / 2;
        const cy = height / 2;
        const scale = Math.min(width, height) * 0.3;

        pointer.x += (pointer.targetX - pointer.x) * 0.05;
        pointer.y += (pointer.targetY - pointer.y) * 0.05;

        const spin = time * 0.16 + pointer.x * 0.6;
        const lean = -0.32 + pointer.y * 0.3;
        const cosSpin = Math.cos(spin);
        const sinSpin = Math.sin(spin);
        const cosLean = Math.cos(lean);
        const sinLean = Math.sin(lean);

        orbits.forEach(function (orbit) {
            drawOrbit(orbit, scale, cx, cy, time, false);
        });

        for (let i = 0; i < POINT_COUNT; i++) {
            const point = points[i];
            const rx = point.x * cosSpin + point.z * sinSpin;
            const rz = -point.x * sinSpin + point.z * cosSpin;
            const ry = point.y * cosLean - rz * sinLean;
            const depth = point.y * sinLean + rz * cosLean;
            const nearness = (depth + 1) / 2;

            ctx.beginPath();
            ctx.arc(cx + rx * scale, cy + ry * scale, Math.max(0.5, (0.5 + nearness * 1.5) * (scale / 180)), 0, Math.PI * 2);
            ctx.fillStyle = depth > 0
                ? 'rgba(' + Math.round(165 + nearness * 90) + ',' + Math.round(107 + nearness * 130) + ',255,' + (0.35 + nearness * 0.65) + ')'
                : 'rgba(120, 70, 220,' + (0.08 + nearness * 0.3) + ')';
            ctx.fill();
        }

        orbits.forEach(function (orbit) {
            drawOrbit(orbit, scale, cx, cy, time, true);
        });
    }

    function loop(now) {
        draw(now / 1000);
        animationId = requestAnimationFrame(loop);
    }

    function updateAnimation() {
        const shouldRun = isVisible && !splineReady && !reducedMotion && !document.hidden;
        if (shouldRun && animationId === null) {
            animationId = requestAnimationFrame(loop);
        } else if (!shouldRun && animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }

    function resize() {
        const rect = visual.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        width = rect.width;
        height = rect.height;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (reducedMotion) draw(8);
    }

    // Older browsers lack these observers; resizing the window and always animating still works.
    if ('ResizeObserver' in window) {
        new ResizeObserver(resize).observe(visual);
    } else {
        window.addEventListener('resize', resize);
    }
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
            isVisible = entries[0].isIntersecting;
            updateAnimation();
        }).observe(visual);
    }
    document.addEventListener('visibilitychange', updateAnimation);

    if (!reducedMotion) {
        window.addEventListener('pointermove', function (event) {
            pointer.targetX = event.clientX / window.innerWidth - 0.5;
            pointer.targetY = event.clientY / window.innerHeight - 0.5;
        }, { passive: true });
    }

    resize();
    updateAnimation();

    // Swap in the Spline scene only after it has fully loaded.
    const splineUrl = visual.dataset.splineUrl;
    if (splineUrl) {
        import(VIEWER_SRC).then(function () {
            const viewer = document.createElement('spline-viewer');
            viewer.addEventListener('load-complete', function () {
                splineReady = true;
                visual.classList.add('spline-ready');
                updateAnimation();
            });
            viewer.setAttribute('url', splineUrl);
            visual.appendChild(viewer);
        }).catch(function (error) {
            console.warn('Spline viewer failed to load; keeping the canvas visual.', error);
        });
    }
})();
