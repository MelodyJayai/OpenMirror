const nameInput = document.getElementById('name');
const portInput = document.getElementById('port');
const saveButton = document.getElementById('save');
const closeButton = document.getElementById('close');
const result = document.getElementById('result');

window.openmirror.getSettings().then((settings) => {
  nameInput.value = settings.name;
  portInput.value = settings.port;
});

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  result.textContent = '正在保存并重启接收器…';
  try {
    const { settings, receiver } = await window.openmirror.saveSettings({
      name: nameInput.value,
      port: Number(portInput.value),
    });
    nameInput.value = settings.name;
    portInput.value = settings.port;
    result.textContent = `已保存，接收器运行在端口 ${receiver.port}`;
  } catch (error) {
    result.textContent = `保存失败：${error.message}`;
  } finally {
    saveButton.disabled = false;
  }
});

closeButton.addEventListener('click', () => window.close());
