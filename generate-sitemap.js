const fs = require('fs');
const path = require('path');

const DOMAIN = 'https://usachildsupportcalculator.com';
const states = require('./data/states.json');
const SATELLITES = require('./data/satellites.json');

const today = new Date().toISOString().split('T')[0];

let urls = [];

urls.push({ loc: `${DOMAIN}/`, lastmod: today, changefreq: 'monthly', priority: '1.0' });
urls.push({ loc: `${DOMAIN}/about/`, lastmod: today, changefreq: 'yearly', priority: '0.3' });
urls.push({ loc: `${DOMAIN}/privacy/`, lastmod: today, changefreq: 'yearly', priority: '0.3' });
urls.push({ loc: `${DOMAIN}/changelog/`, lastmod: today, changefreq: 'weekly', priority: '0.4' });

Object.values(states).forEach(state => {
  if (!fs.existsSync(path.join(__dirname, state.slug, 'index.html'))) return;
  urls.push({
    loc: `${DOMAIN}/${state.slug}/`,
    lastmod: state.last_verified,
    changefreq: 'monthly',
    priority: '0.9'
  });
});

Object.values(SATELLITES).forEach(sat => {
  if (!fs.existsSync(path.join(__dirname, sat.slug, 'index.html'))) return;
  urls.push({
    loc: `${DOMAIN}/${sat.slug}/`,
    lastmod: today,
    changefreq: 'monthly',
    priority: '0.7'
  });
});

['child-support-arrears-calculator', 'child-support-modification-calculator', 'compare'].forEach(slug => {
  if (!fs.existsSync(path.join(__dirname, slug, 'index.html'))) return;
  urls.push({ loc: `${DOMAIN}/${slug}/`, lastmod: today, changefreq: 'monthly', priority: '0.7' });
});

const GUIDES = require('./data/guides.json');
if (fs.existsSync(path.join(__dirname, 'guides', 'index.html'))) {
  urls.push({ loc: `${DOMAIN}/guides/`, lastmod: today, changefreq: 'monthly', priority: '0.6' });
}
GUIDES.forEach(g => {
  if (!fs.existsSync(path.join(__dirname, 'guides', g.slug, 'index.html'))) return;
  urls.push({ loc: `${DOMAIN}/guides/${g.slug}/`, lastmod: today, changefreq: 'yearly', priority: '0.6' });
});
if (fs.existsSync(path.join(__dirname, 'guides', 'child-support-by-state-2026', 'index.html'))) {
  urls.push({ loc: `${DOMAIN}/guides/child-support-by-state-2026/`, lastmod: today, changefreq: 'yearly', priority: '0.8' });
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;

fs.writeFileSync(path.join(__dirname, 'sitemap.xml'), xml, 'utf8');
console.log(`sitemap.xml written: ${urls.length} URLs (only states/satellites actually present in data/)`);
