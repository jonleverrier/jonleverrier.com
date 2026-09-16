/**
 * PRINT
 *
 * The two things a printed page needs that CSS cannot do for it.
 *
 * ONE — the provenance line that ends the sheet: the address it came from and the
 * moment it was taken. The markup is in _includes/page/print-footer.twig and is only
 * ever visible inside @media print (theme/_print.scss).
 *
 * TWO — the images. Every image below the fold is `loading="lazy"`, and the two
 * engines disagree about what that means when you print: Chrome force-loads them as
 * part of laying the document out, WebKit does not. So a Safari print of a page the
 * visitor had not scrolled through came out with the last few pictures missing —
 * measured on /case-studies: 44 lazy images, 26 of them still unloaded.
 *
 * Written at PRINT time, not at load time. The date has to be when the sheet was
 * made: stamped on load it would be wrong for anyone who leaves a tab open, and
 * stamped on the server it would be the render time, which a template cache can make
 * days old while still reading as "now".
 *
 * Two triggers for one job. `beforeprint` is the direct signal, but it is also the one
 * that historically went missing in Safari; a matchMedia('print') listener catches the
 * same moment through a different door. Both run the same idempotent write, so firing
 * twice costs one string each.
 */

const ORDINALS = ['th', 'st', 'nd', 'rd'];

// 1st, 2nd, 3rd, 4th … and 11th/12th/13th, which break the pattern: they take "th"
// despite ending in 1, 2 and 3.
function ordinal(day) {
    const teens = day % 100;
    if (teens >= 11 && teens <= 13) return 'th';
    return ORDINALS[day % 10] || 'th';
}

// "16th September 2026, 10:39" — the month name from the browser's own en-GB data
// rather than a list kept here, and the clock padded to 24h so 09:05 never prints
// as 9:5.
function stamp(now) {
    const day = now.getDate();
    const month = now.toLocaleDateString('en-GB', {month: 'long'});
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    return `On ${day}${ordinal(day)} ${month} ${now.getFullYear()}, ${hours}:${minutes}`;
}

/**
 * Take every lazy image off its leash and ask for it now.
 *
 * Honest about its limits: `beforeprint` fires as the print is being prepared, so an
 * image that is not already in the cache may not arrive before the first sheet is
 * rendered — a second print will have it. decode() is called so an image that DOES
 * arrive in time is ready to paint rather than merely fetched.
 */
function loadEveryImage() {
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
        img.loading = 'eager';
        if ('fetchPriority' in img) img.fetchPriority = 'high';
        if (typeof img.decode === 'function') img.decode().catch(() => {});
    });
}

export function mountPrint() {
    const footer = document.querySelector('[data-print-footer]');

    const urlEl = footer && footer.querySelector('[data-print-url]');
    const dateEl = footer && footer.querySelector('[data-print-date]');

    const fill = () => {
        loadEveryImage();
        // location.href over the server-rendered fallback: it is the address the
        // visitor is actually on, including any query or fragment the template's
        // absoluteUrl drops.
        if (urlEl) urlEl.textContent = window.location.href;
        if (dateEl) dateEl.textContent = stamp(new Date());
    };

    const media = window.matchMedia('print');
    const onMedia = (event) => { if (event.matches) fill(); };

    window.addEventListener('beforeprint', fill);
    media.addEventListener('change', onMedia);

    return () => {
        window.removeEventListener('beforeprint', fill);
        media.removeEventListener('change', onMedia);
    };
}
