export async function registerModule(bus) {
  bus.on('optics.active', 'optics', () => true);
}
