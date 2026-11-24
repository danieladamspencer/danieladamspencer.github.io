# dancmdstat.com

Personal site of Dan Spencer: plain HTML and one stylesheet, no build step.
GitHub Pages serves this repo as-is (`.nojekyll` turns Jekyll off).

- `index.html`: home (about, interests, software)
- `cv/index.html`: CV (print-friendly: "Print or save as PDF")
- `posts/`: Writing. Each post is `posts/<slug>/index.html` with its images beside it;
  list it in `posts/index.html`. Copy an existing post as a template. Posts with math load KaTeX.
- `about/`, `software/`: redirects from the old blogdown site's URLs.
- `assets/style.css`: all styling; light/dark follows the system setting.
- `dinner/`: password-protected dinner booking for friends, backed by a Google Apps Script
  web app (not linked from the site). Setup and settings are in `dinner/README.md`.

The previous Jekyll site is on the `jekyll-archive` branch.
