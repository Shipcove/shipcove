// Améliorations progressives : le site reste lisible sans JavaScript.

// Menu mobile.
const toggle = document.querySelector('.nav-toggle');
const sidebar = document.getElementById('sidebar');
toggle?.addEventListener('click', () => {
  const open = sidebar.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', String(open));
});

// Ancres des titres et sommaire « Sur cette page ».
const slug = (t) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const toc = document.querySelector('.toc-list');
const headings = [...document.querySelectorAll('.prose-doc h2, .prose-doc h3')];
for (const h of headings) {
  if (!h.id) h.id = slug(h.textContent);
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = `#${h.id}`;
  a.textContent = h.textContent;
  if (h.tagName === 'H3') a.className = 'is-h3';
  li.append(a);
  toc?.append(li);
}
if (!headings.length) document.querySelector('.toc')?.remove();

// Copie des blocs de code.
for (const pre of document.querySelectorAll('.prose-doc pre')) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copier';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
      btn.textContent = 'Copié';
    } catch {
      btn.textContent = 'Échec';
    }
    setTimeout(() => (btn.textContent = 'Copier'), 1500);
  });
  pre.append(btn);
}
