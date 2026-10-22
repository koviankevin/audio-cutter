(() => {
  const key = 'audio-cutter:font-size';
  const sizes = new Set(['standard', 'large', 'extra-large']);
  let current = 'standard';
  let storageAvailable = true;

  function apply(value) {
    current = sizes.has(value) ? value : 'standard';
    document.documentElement.dataset.fontSize = current;
    document.querySelectorAll('[name="font-size"]').forEach((input) => {
      input.checked = input.value === current;
    });
    window.dispatchEvent(new Event('font-size-change'));
  }

  // Apply before the stylesheet and page render, so a saved size does not flash.
  try {
    current = localStorage.getItem(key);
  } catch {
    storageAvailable = false;
  }
  apply(current);

  document.addEventListener('DOMContentLoaded', () => {
    apply(current);
    const note = document.getElementById('font-size-storage-note');
    note.hidden = storageAvailable;
    document.querySelectorAll('[name="font-size"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked || !sizes.has(input.value)) return;
        apply(input.value);
        try {
          localStorage.setItem(key, current);
          note.hidden = true;
        } catch {
          note.hidden = false;
        }
      });
    });
    window.addEventListener('storage', (event) => {
      if (event.key === key || event.key === null) apply(event.newValue);
    });
  });
})();
