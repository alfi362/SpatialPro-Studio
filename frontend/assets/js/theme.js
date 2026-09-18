(() => {
    try {
        const savedTheme = localStorage.getItem('spatialpro-theme');
        const preferredTheme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        const activeTheme = savedTheme || preferredTheme;
        document.documentElement.dataset.theme = activeTheme;
        document.querySelector('meta[name="theme-color"]').content = activeTheme === 'dark' ? '#090b11' : '#f4f5f9';
    } catch (_) {
        document.documentElement.dataset.theme = 'dark';
    }
})();
