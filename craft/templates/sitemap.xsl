{#
  sitemap.xsl — the human-readable face of /sitemap.xml.

  The sitemap carries an <?xml-stylesheet?> instruction pointing here. A BROWSER
  follows it and renders the table below; a CRAWLER ignores it and reads the raw
  <urlset> exactly as before. So this changes nothing about the sitemap as a
  machine document — it's a courtesy for whoever opens the URL by hand.

  A Craft template rather than a static file in public/, for one reason: the
  header below. A browser will only apply a stylesheet served as text/xsl, and
  nginx has no mapping for the .xsl extension — served statically it arrives as
  plain text and the sitemap renders as a wall of tags.

  XSLT 1.0 is all any browser implements, so there are no date functions: the
  dd/mm/yyyy below is cut out of the ISO timestamp by hand, three substrings put
  back in the other order.

  The caption counts the <url> elements, so it can never disagree with the rows
  beneath it.

  Also: no grouping worth the trouble, and `{…}` in an attribute is an XSLT
  value, not Twig — single braces pass through untouched.

  The column headers sort the table. That is the one thing here that needs
  JavaScript, and it runs the same as in any document because the transform's
  output IS an ordinary HTML document. Each cell carries a `data-sort` holding
  the raw value — the ISO timestamp behind the printed dd/mm/yyyy — so the sort
  is a plain string comparison and never has to parse a date. Nothing is ever
  hidden, so the count above the table stays true.
#}
{%- header 'Content-Type: text/xsl; charset=UTF-8' -%}
<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">
    <xsl:output method="html" encoding="UTF-8" indent="yes"/>

    <xsl:template match="/">
        <html lang="en">
            <head>
                <meta charset="UTF-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <meta name="robots" content="noindex"/>
                <title>Sitemap | {{ siteName }}</title>
                <style>
                    /* The site's own faces. Resolved through the Vite manifest rather
                       than typed, so the content-hashed filenames stay right across
                       builds. Only the two weights this page uses: the sans bold for
                       the heading, the mono light and bold for everything else. */
                    @font-face {
                        font-family: 'JonSonSans';
                        src: url('{{ craft.vite.asset('build/fonts/Baikal-ExpandedBold.woff2') }}') format('woff2');
                        font-weight: 600;
                        font-display: fallback;
                    }
                    @font-face {
                        font-family: 'JonSonMono';
                        src: url('{{ craft.vite.asset('build/fonts/soehne-mono-leicht.woff2') }}') format('woff2');
                        font-weight: 500;
                        font-display: fallback;
                    }
                    @font-face {
                        font-family: 'JonSonMono';
                        src: url('{{ craft.vite.asset('build/fonts/soehne-mono-halbfett.woff2') }}') format('woff2');
                        font-weight: 600;
                        font-display: fallback;
                    }
                    /* The site's palette, copied out of theme/_setup.scss with the
                       token each one is. Copied, not imported: this file is Twig,
                       and the palette is a Sass map with no runtime equivalent — so
                       if a token changes there, change it here too. */
                    :root {
                        --cream: #e8e2d5;  /* light 600  — the content-page slab */
                        --white: #fff;     /* light 100  — the row hover, and the pill's text */
                        --navy: #0c243c;   /* primary 700 */
                        --whisper: #3a6479;/* primary 450 — the blue every eyebrow on the site uses */
                        --grey: #4d4d4d;   /* light 860  — the footnote grey, as the "last updated" line */
                        --rule: #aca89e;   /* light 750  — the timeline's grey-taupe, and every box border */
                        --red: #b62515;    /* primary 650 — the TEXT red for cream; 600 is the button red
                                              and sits at 3.56:1 here, which fails AA */
                        --red-dark: #9b1f12;/* the same red 15% darker — accent-link's hover */
                    }
                    * { box-sizing: border-box; }
                    body {
                        margin: 0;
                        padding: 4rem 2rem 6rem;
                        background: var(--cream);
                        color: var(--navy);
                        font: 500 16px/1.5 'JonSonMono', ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
                    }
                    .wrap { max-width: 74rem; margin: 0 auto; }
                    .eyebrow {
                        margin: 0 0 .75rem;
                        font-size: 12px;
                        letter-spacing: .19em;
                        text-transform: uppercase;
                        font-weight: 600; /* the mono's real bold — there is no 700 face */
                        color: var(--whisper);
                    }
                    h1 {
                        margin: 0 0 2.5rem; /* the gap the lede used to leave under it */
                        font-size: clamp(28px, 5vw, 44px);
                        line-height: 1.15;
                        font-family: 'JonSonSans', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                        font-weight: 600; /* the sans's bold, and the only weight loaded here */
                        letter-spacing: -.02em;
                    }
                    table { width: 100%; border-collapse: collapse; font: inherit; }
                    caption { text-align: left; }
                    th {
                        padding: .6rem .8rem;
                        white-space: nowrap; /* "Last modified" is wider than the date under it */
                        border-bottom: 2px solid var(--navy);
                        text-align: left;
                        font-size: 12px;
                        letter-spacing: .12em;
                        text-transform: uppercase;
                        font-weight: 600;
                        color: var(--whisper);
                    }
                    td {
                        padding: .7rem .8rem;
                        border-bottom: 1px solid var(--rule);
                        vertical-align: top;
                        word-break: break-word;
                    }
                    /* The count in a pill, ahead of the word it counts. Right margin
                       rather than left, since the number now leads. */
                    .count {
                        display: inline-block;
                        margin-right: .35rem;
                        padding: .15rem .6rem;
                        border-radius: 99rem;
                        background: var(--navy);
                        color: var(--white);
                        font-size: 13px;
                        font-weight: 600;
                    }
                    tr:hover td { background: var(--white); }
                    th.sortable { cursor: pointer; -webkit-user-select: none; user-select: none; }
                    th.sortable:hover { color: var(--red); }
                    .arrow { display: inline-block; width: 1em; color: var(--rule); }
                    th[data-dir="asc"] .arrow::after { content: "\2191"; color: var(--navy); }
                    th[data-dir="desc"] .arrow::after { content: "\2193"; color: var(--navy); }
                    td.n { width: 3.5rem; color: var(--grey); text-align: right; }
                    td.when { width: 9rem; color: var(--grey); white-space: nowrap; }
                    /* The site's own link treatment (the accent-link mixin): the text red,
                       no underline at rest, a darker red and an underline on hover, clear
                       of the descenders. Copied out of the compiled CSS rather than
                       approximated, so a link here reads exactly as one in the prose. */
                    a {
                        color: var(--red);
                        text-decoration: none;
                        text-underline-offset: 4px;
                        transition: color 200ms ease;
                    }
                    a:hover { color: var(--red-dark); text-decoration: underline; }
                    @media (max-width: 40rem) {
                        body { padding: 2rem 1rem 4rem; }
                        td.n { display: none; }
                        th.n { display: none; }
                        td.when { width: 7rem; font-size: 13px; }
                    }
                </style>
            </head>
            <body>
                <div class="wrap">
                    <h1>{{ siteName }} Sitemap</h1>
                    <table>
                        <caption class="eyebrow">
                            <span class="count"><xsl:value-of select="count(s:urlset/s:url)"/></span> URLs
                        </caption>
                        <thead>
                            <tr>
                                <th class="n">#</th>
                                <th class="sortable" data-key="url">URL<span class="arrow"></span></th>
                                <th class="sortable" data-key="when">Last modified<span class="arrow"></span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <xsl:for-each select="s:urlset/s:url">
                                <tr>
                                    <td class="n"><xsl:value-of select="position()"/></td>
                                    <td data-key="url" data-sort="{s:loc}">
                                        <a href="{s:loc}"><xsl:value-of select="s:loc"/></a>
                                    </td>
                                    <td class="when" data-key="when" data-sort="{s:lastmod}">
                                        <xsl:variable name="lm" select="s:lastmod"/>
                                        <xsl:value-of select="substring($lm, 9, 2)"/>/<xsl:value-of select="substring($lm, 6, 2)"/>/<xsl:value-of select="substring($lm, 1, 4)"/>
                                    </td>
                                </tr>
                            </xsl:for-each>
                        </tbody>
                    </table>
                </div>
                <script type="text/javascript">
<![CDATA[
(function () {
    var table = document.querySelector('table');
    if (!table) { return; }
    var body = table.tBodies[0];
    var heads = table.querySelectorAll('th.sortable');

    // Renumber the # column after every sort, so it always reads 1..n down the
    // page rather than keeping each row's original position.
    function renumber() {
        var rows = body.rows;
        for (var i = 0; i < rows.length; i++) {
            var cell = rows[i].querySelector('td.n');
            if (cell) { cell.textContent = String(i + 1); }
        }
    }

    function sortBy(th) {
        var key = th.getAttribute('data-key');
        var dir = th.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';
        for (var h = 0; h < heads.length; h++) { heads[h].removeAttribute('data-dir'); }
        th.setAttribute('data-dir', dir);

        // Sort on the cell's data-sort, not on what is printed: the date shows as
        // dd/mm/yyyy but carries the ISO timestamp, which sorts correctly as plain
        // text and needs no parsing.
        var sel = 'td[data-key="' + key + '"]';
        var value = function (row) {
            var cell = row.querySelector(sel);
            return cell ? cell.getAttribute('data-sort') || '' : '';
        };
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (a, b) {
            var as = value(a);
            var bs = value(b);
            if (as === bs) { return 0; }
            return (as > bs ? 1 : -1) * (dir === 'asc' ? 1 : -1);
        });
        for (var r = 0; r < rows.length; r++) { body.appendChild(rows[r]); }
        renumber();
    }

    for (var i = 0; i < heads.length; i++) {
        (function (th) {
            th.addEventListener('click', function () { sortBy(th); });
        })(heads[i]);
    }
})();
]]>
                </script>
            </body>
        </html>
    </xsl:template>
</xsl:stylesheet>
