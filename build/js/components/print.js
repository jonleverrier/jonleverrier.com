/**
 * PRINT
 *
 * The one thing a printed page needs that CSS cannot do for it: the images. Every image below the fold is `loading="lazy"`, and the two
 * engines disagree about what that means when you print: Chrome force-loads them as
 * part of laying the document out, WebKit does not. So a Safari print of a page the
 * visitor had not scrolled through came out with the last few pictures missing —
 * measured on /case-studies: 44 lazy images, 26 of them still unloaded.
 *
 * Two triggers for one job. `beforeprint` is the direct signal, but it is also the one
 * that historically went missing in Safari; a matchMedia('print') listener catches the
 * same moment through a different door. Both run the same idempotent pass, so firing
 * twice costs nothing.
 */

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
    const media = window.matchMedia('print');
    const onMedia = (event) => { if (event.matches) loadEveryImage(); };

    window.addEventListener('beforeprint', loadEveryImage);
    media.addEventListener('change', onMedia);

    return () => {
        window.removeEventListener('beforeprint', loadEveryImage);
        media.removeEventListener('change', onMedia);
    };
}
