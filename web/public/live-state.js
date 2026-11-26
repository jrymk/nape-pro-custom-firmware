export function liveSelection(config, deviceProfiles, status) {
  if (!status?.running || status.recovery || !deviceProfiles) return null;
  const profile = config.profiles.indexOf(deviceProfiles[status.profile]);
  if (profile < 0 || config.profiles[profile].disabled) return null;
  let layer = 0;
  for (let i = 1; i < 8; i++) if (status.layers & (1 << i)) layer = i;
  return { profile, layer };
}
