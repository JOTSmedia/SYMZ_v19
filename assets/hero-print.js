(() => {
  const hero = document.getElementById('hero'), texture = document.querySelector('.hero-texture');
  const canvas = document.getElementById('heroPrint'), surface = document.getElementById('heroPaperSurface');
  const headSource = window.symzPrintHead;
  if (!hero || !texture || !canvas || !surface || !headSource) return;
  const ctx = canvas.getContext('2d'), output = surface.getContext('2d');
  if (!ctx || !output) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const material = new Image(), base = document.createElement('canvas'), mask = document.createElement('canvas');
  const baseCtx = base.getContext('2d'), maskCtx = mask.getContext('2d');
  if (!baseCtx || !maskCtx) return;
  const source = new URL('assets/waffle-surface.svg', document.baseURI).href;
  const printTime = 1250, rings = 4;
  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  let width = 0, height = 0, density = 1, loaded = false, visible = false, request = 0;
  let elapsed = 0, last = 0, lastPaint = -Infinity, resizeTimer = 0, awaitingIntro = false, complete = false;
  let geometry = null, paths = [], segments = [], totalDistance = 0;

  function defaultGeometry() {
    const g = { width: 1600, height: 900, radius: 230, perspective: .18, rounding: .18, cells: [] };
    const dx = Math.sqrt(3) * g.radius, dy = 1.5 * g.radius;
    for (let row = -2; row < Math.ceil(g.height / (1 - g.perspective) / dy) + 3; row++) {
      for (let column = -3; column < Math.ceil(g.width / dx) + 4; column++) {
        g.cells.push({ x: column * dx + ((row % 2 + 2) % 2) * dx / 2, y: row * dy, row, column });
      }
    }
    return g;
  }

  function unitContour() {
    const vertices = Array.from({ length: 6 }, (_, i) => ({ x: Math.cos(-Math.PI / 2 + i * Math.PI / 3), y: Math.sin(-Math.PI / 2 + i * Math.PI / 3) }));
    const result = [], rounding = geometry.rounding;
    for (let i = 0; i < 6; i++) {
      const vertex = vertices[i], entry = mix(vertex, vertices[(i + 5) % 6], rounding);
      const exit = mix(vertex, vertices[(i + 1) % 6], rounding), next = mix(vertices[(i + 1) % 6], vertex, rounding);
      for (let n = 0; n < 8; n++) {
        const t = n / 8, a = mix(entry, vertex, t), b = mix(vertex, exit, t);
        result.push(mix(a, b, t));
      }
      for (let n = 0; n < 8; n++) result.push(mix(exit, next, n / 8));
    }
    return result;
  }

  function project(point, fit) {
    const scale = 1 / (1 + geometry.perspective * point.y / geometry.height);
    return {
      x: fit.x + (geometry.width / 2 + (point.x - geometry.width / 2) * scale) * fit.scale,
      y: fit.y + point.y * scale * fit.scale
    };
  }

  function makeToolpaths(fit) {
    const unit = unitContour(), radius = geometry.radius;
    const pending = geometry.cells.map(cell => {
      const center = project(cell, fit), scale = fit.scale / (1 + geometry.perspective * cell.y / geometry.height);
      const outer = unit.map(point => project({ x: cell.x + point.x * radius, y: cell.y + point.y * radius }, fit));
      const stroke = radius * .34 * scale;
      return { ...cell, center, stroke, outer };
    }).filter(cell => {
      const xs = cell.outer.map(p => p.x), ys = cell.outer.map(p => p.y), margin = cell.stroke;
      return Math.max(...xs) + margin > 0 && Math.min(...xs) - margin < width && Math.max(...ys) + margin > 0 && Math.min(...ys) - margin < height;
    });
    paths = []; segments = []; totalDistance = 0;
    let from = { x: width * .75, y: height * .2 };
    while (pending.length) {
      let nearest = 0;
      for (let i = 1; i < pending.length; i++) if (distance(pending[i].center, from) < distance(pending[nearest].center, from)) nearest = i;
      const cell = pending.splice(nearest, 1)[0];
      let first = 0;
      for (let i = 1; i < unit.length; i++) if (distance(cell.outer[i], from) < distance(cell.outer[first], from)) first = i;
      const points = [];
      const at = (index, scale) => {
        const point = unit[(index + first) % unit.length];
        return project({ x: cell.x + point.x * radius * scale, y: cell.y + point.y * radius * scale }, fit);
      };
      // The first circuit follows the recess itself; nested contours fill its face.
      for (let i = 0; i <= unit.length; i++) points.push(at(i, .92));
      for (let i = 1; i <= unit.length * rings; i++) points.push(at(i, .92 * (1 - i / (unit.length * rings))));
      const cumulative = [0];
      for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
      const path = new Path2D(); path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
      const item = { points, cumulative, path, stroke: cell.stroke, length: cumulative.at(-1), center: cell.center };
      if (paths.length) {
        const travel = distance(from, points[0]);
        if (travel > 1) {
          segments.push({ type: 'travel', from, to: points[0], start: totalDistance, end: totalDistance + travel, length: travel, cell: paths.length });
          totalDistance += travel;
        }
      }
      segments.push({ type: 'extrude', start: totalDistance, end: totalDistance + item.length, length: item.length, cell: paths.length });
      totalDistance += item.length; paths.push(item); from = points.at(-1);
    }
  }

  function onPath(path, amount) {
    const target = Math.max(0, Math.min(path.length, amount));
    let low = 0, high = path.cumulative.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (path.cumulative[middle] <= target) low = middle; else high = middle;
    }
    const span = path.cumulative[high] - path.cumulative[low];
    return { ...mix(path.points[low], path.points[high], span ? (target - path.cumulative[low]) / span : 0), index: high };
  }

  function position(time) {
    const progress = clamp(time / printTime), amount = progress * totalDistance;
    const segment = segments.find(item => amount <= item.end) || segments.at(-1);
    if (!segment) return { x: width / 2, y: height / 2, progress, cell: 0, extruding: false, amount };
    const tip = segment.type === 'travel' ? mix(segment.from, segment.to, clamp((amount - segment.start) / segment.length)) : onPath(paths[segment.cell], amount - segment.start);
    return { ...tip, progress, cell: segment.cell, extruding: segment.type === 'extrude', amount };
  }

  function paintBackground(time) {
    const progress = clamp(time / printTime), finished = progress === 1;
    hero.style.setProperty('--hero-print-bg', finished ? '#fff' : '#000');
    hero.style.setProperty('--hero-print-ink', finished ? '#000' : '#fff');
    hero.toggleAttribute('data-print-complete', finished);
    hero.toggleAttribute('data-pulse-ready', finished && !reduced.matches);
    canvas.dataset.backgroundProgress = progress.toFixed(4);
  }

  function rebuild() {
    const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
    if (!width || !height || !loaded) return;
    density = Math.min(devicePixelRatio || 1, 1.25);
    for (const target of [canvas, surface, base, mask]) { target.width = Math.round(width * density); target.height = Math.round(height * density); }
    const scale = Math.max(width / geometry.width, height / geometry.height);
    const fit = { scale, x: (width - geometry.width * scale) / 2, y: (height - geometry.height * scale) / 2 };
    makeToolpaths(fit);
    baseCtx.setTransform(density, 0, 0, density, 0, 0); baseCtx.clearRect(0, 0, width, height);
    baseCtx.globalAlpha = .72 * .88;
    baseCtx.drawImage(material, fit.x, fit.y, geometry.width * scale, geometry.height * scale);
    baseCtx.globalAlpha = 1;
    const wash = width < 761 ? baseCtx.createLinearGradient(0, 0, 0, height) : baseCtx.createLinearGradient(0, 0, width, 0);
    wash.addColorStop(0, 'rgba(255,255,255,.08)'); wash.addColorStop(width < 761 ? .38 : .43, 'rgba(255,255,255,.15)'); wash.addColorStop(width < 761 ? .68 : .7, '#fff'); wash.addColorStop(1, '#fff');
    baseCtx.globalCompositeOperation = 'destination-in'; baseCtx.fillStyle = wash; baseCtx.fillRect(0, 0, width, height);
    baseCtx.globalCompositeOperation = 'destination-over'; baseCtx.fillStyle = '#fff'; baseCtx.fillRect(0, 0, width + 2, height + 2); baseCtx.globalCompositeOperation = 'source-over';
    lastPaint = -Infinity; draw(reduced.matches || complete ? printTime : elapsed, true); start();
  }

  function reveal(time) {
    const amount = clamp(time / printTime) * totalDistance;
    maskCtx.setTransform(density, 0, 0, density, 0, 0); maskCtx.clearRect(0, 0, width, height);
    maskCtx.strokeStyle = '#fff'; maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';
    for (const segment of segments) {
      if (segment.start >= amount) break;
      if (segment.type !== 'extrude') continue;
      const path = paths[segment.cell]; maskCtx.lineWidth = path.stroke;
      if (segment.end <= amount) maskCtx.stroke(path.path);
      else {
        const tip = onPath(path, amount - segment.start), partial = new Path2D();
        partial.moveTo(path.points[0].x, path.points[0].y);
        for (let i = 1; i < tip.index; i++) partial.lineTo(path.points[i].x, path.points[i].y);
        partial.lineTo(tip.x, tip.y); maskCtx.stroke(partial);
      }
    }
    output.setTransform(1, 0, 0, 1, 0, 0); output.clearRect(0, 0, surface.width, surface.height);
    output.drawImage(base, 0, 0); output.globalCompositeOperation = 'destination-in'; output.drawImage(mask, 0, 0); output.globalCompositeOperation = 'source-over';
    canvas.dataset.textureProgress = clamp(time / printTime).toFixed(4);
  }

  function draw(time, force = false) {
    if (!loaded || !width || !height || !paths.length) return;
    const duration = reduced.matches || complete ? printTime : Math.min(printTime, time), tip = position(duration);
    paintBackground(duration);
    ctx.setTransform(density, 0, 0, density, 0, 0); ctx.clearRect(0, 0, width, height);
    const head = headSource.heads[50];
    if (head) {
      const [x, y, w, h, anchorX, anchorY] = headSource.level.head, scale = (width < 600 ? 38 : 46) / w;
      const left = tip.x + (x - anchorX) * scale, top = tip.y + (y - anchorY) * scale;
      window.symzIntro?.heroWriter(head, left, top, w * scale, h * scale, ctx, canvas);
      if (!window.symzIntro || window.symzIntro.finished) {
        const fade = reduced.matches || duration >= printTime ? 0 : 1 - smooth((duration - printTime + 160) / 160);
        if (window.symzIntro) window.symzIntro.writer.style.opacity = String(.65 * fade);
        else if (fade) { ctx.globalAlpha = .65 * fade; ctx.drawImage(head, left, top, w * scale, h * scale); ctx.globalAlpha = 1; }
        if (fade > 0) {
          ctx.globalAlpha = .16 * fade; ctx.strokeStyle = '#626970'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(tip.x + headSource.level.tube[0] * scale, tip.y + headSource.level.tube[1] * scale);
          ctx.bezierCurveTo(tip.x - 18, tip.y - 110, tip.x + 65, -30, width * .8, -30); ctx.stroke(); ctx.globalAlpha = 1;
        }
      }
    }
    if (window.symzIntro && !window.symzIntro.finished) return;
    if (force || time !== lastPaint || duration >= printTime) { reveal(duration); lastPaint = time; }
    const finished = duration >= printTime;
    canvas.classList.add('is-ready'); canvas.dataset.printState = reduced.matches ? 'static' : finished ? 'complete' : 'printing';
    canvas.dataset.progress = tip.progress.toFixed(4); canvas.dataset.nozzleX = tip.x.toFixed(2); canvas.dataset.nozzleY = tip.y.toFixed(2);
    canvas.dataset.duration = String(printTime); canvas.dataset.totalWriterDuration = '2300';
    canvas.dataset.printedCells = String(finished ? paths.length : tip.cell); canvas.dataset.totalCells = String(paths.length);
    canvas.dataset.currentCell = String(tip.cell + 1); canvas.dataset.extruding = String(tip.extruding && !finished);
    canvas.dataset.toolpathMode = 'rounded-hex-contours-and-infill'; canvas.dataset.rasterRows = '0';
    canvas.dataset.material = 'assets/waffle-surface.svg'; canvas.dataset.textPaths = '0'; canvas.dataset.avatarPaths = '0';
  }

  function stop() { cancelAnimationFrame(request); request = 0; last = 0; if (!complete && !reduced.matches) canvas.dataset.printState = 'paused'; }
  function frame(now) {
    request = 0; if (!visible || document.hidden) { last = 0; return; }
    if (last) elapsed += now - last; last = now; draw(elapsed);
    if (elapsed >= printTime) { complete = true; canvas.dataset.printState = 'complete'; return; }
    request = requestAnimationFrame(frame);
  }
  function start() {
    hero.toggleAttribute('data-background-visible', visible && !document.hidden);
    stop(); if (!visible || !loaded || !width || document.hidden) return;
    draw(reduced.matches || complete ? printTime : elapsed, true);
    if (window.symzIntro && !window.symzIntro.finished) {
      if (!awaitingIntro) { awaitingIntro = true; window.symzIntro.ready.then(() => { awaitingIntro = false; start(); }); }
      return;
    }
    if (reduced.matches || complete) return;
    request = requestAnimationFrame(frame);
  }
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; hero.toggleAttribute('data-background-visible', visible); start(); }).observe(hero);
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(rebuild, 80); }).observe(canvas);
  document.addEventListener('visibilitychange', start); reduced.addEventListener('change', start);
  window.addEventListener('symz-printer-head', () => { if (loaded && visible && reduced.matches) draw(printTime, true); });
  const imageReady = new Promise((resolve, reject) => { material.onload = resolve; material.onerror = reject; material.src = source; });
  const geometryReady = fetch(source).then(response => { if (!response.ok) throw new Error('Waffle geometry unavailable'); return response.text(); })
    .then(svg => JSON.parse(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('#waffle-geometry').textContent))
    .catch(defaultGeometry);
  Promise.all([window.symzLoaded || Promise.resolve(), imageReady, geometryReady]).then(([, , data]) => {
    geometry = data; loaded = true; rebuild();
  }).catch(() => { paintBackground(printTime); hero.removeAttribute('data-pulse-ready'); canvas.dataset.printState = 'fallback'; });
})();
