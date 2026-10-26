abi <abi/4.0>,
include <tunables/global>

# Obstat itself (Electron needs user namespaces for its own sandbox)
profile "${executable}" "/opt/${sanitizedProductName}/${executable}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}

# Obstat's own bubblewrap, which walls off sandbox tests (lib/confine.js). Ubuntu 24.04
# and later only let programs with a profile like this make the user namespaces it needs.
profile "${executable}-bwrap" "/opt/${sanitizedProductName}/resources/bwrap" flags=(unconfined) {
  userns,

  include if exists <local/${executable}-bwrap>
}
