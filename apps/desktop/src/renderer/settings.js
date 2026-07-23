const nameInput = document.getElementById('name');
const portInput = document.getElementById('port');
const displaySelect = document.getElementById('display');
const fullscreenInput = document.getElementById('fullscreen');
const saveButton = document.getElementById('save');
const closeButton = document.getElementById('close');
const result = document.getElementById('result');

function renderDisplayOptions(displays, selectedId) {
  displaySelect.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '主显示器（默认）';
  displaySelect.append(auto);
  for (const display of displays) {
    const option = document.createElement('option');
    option.value = String(display.id);
    const size = `${display.bounds.width}×${display.bounds.height}`;
    option.textContent = `${display.label}（${size}${display.primary ? '，主显示器' : ''}）`;
    displaySelect.append(option);
  }
  displaySelect.value = selectedId != null ? String(selectedId) : '';
  if (displaySelect.selectedIndex === -1) displaySelect.value = '';
}

Promise.all([window.openmirror.getSettings(), window.openmirror.getDisplays()])
  .then(([settings, displays]) => {
    nameInput.value = settings.name;
    portInput.value = settings.port;
    fullscreenInput.checked = settings.fullscreen === true;
    renderDisplayOptions(displays, settings.display);
  });

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  result.textContent = '正在保存…';
  try {
    const { settings, receiver } = await window.openmirror.saveSettings({
      name: nameInput.value,
      port: Number(portInput.value),
      display: displaySelect.value === '' ? null : Number(displaySelect.value),
      fullscreen: fullscreenInput.checked,
    });
    nameInput.value = settings.name;
    portInput.value = settings.port;
    fullscreenInput.checked = settings.fullscreen === true;
    displaySelect.value = settings.display != null ? String(settings.display) : '';
    result.textContent = `已保存，接收器运行在端口 ${receiver.port}`;
  } catch (error) {
    result.textContent = `保存失败：${error.message}`;
  } finally {
    saveButton.disabled = false;
  }
});

closeButton.addEventListener('click', () => window.close());
