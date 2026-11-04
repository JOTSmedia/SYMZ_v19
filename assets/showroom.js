(() => {
  const hero = document.getElementById('hero');
  const control = document.getElementById('heroMotionToggle');
  const navigation = document.querySelector('.nav');
  const ceiling = document.querySelector('.hero-ceiling');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (!hero || !control) return;
  let paused = false;
  let scrollFrame = 0;
  function updateNavigation() {
    scrollFrame = 0;
    if (navigation && ceiling) navigation.classList.toggle('at-hero', ceiling.getBoundingClientRect().bottom > navigation.offsetHeight);
  }
  function update() {
    hero.toggleAttribute('data-pulse-paused', paused || reduced.matches);
    control.setAttribute('aria-pressed', String(paused));
    control.textContent = paused ? 'Resume background' : 'Pause background';
    control.hidden = reduced.matches;
  }
  control.addEventListener('click', () => { paused = !paused;update(); });
  reduced.addEventListener('change', update);
  window.addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateNavigation); }, { passive: true });
  window.addEventListener('resize', updateNavigation);
  updateNavigation();
  update();
})();
