# shellcheck shell=bash disable=SC2154
# Experimental restricted workloads. The gateway, not guest authorized_keys, authenticates access.
os_call() { "${BOXERY_NODE:-node}" "$ROOT/host/backends/lib/openshell.mjs" "$@"; }
backend_check() { need openshell; need "${BOXERY_NODE:-node}"; need ssh; os_call check; }
backend_init() { os_call check; }
backend_proxy_services() { :; }
guest_proxy_upstream() { die "OpenShell uses its own providers; Boxery proxy grants are not supported"; }
backend_build_base() { die "OpenShell requires a prebuilt OCI image (BOXERY_OPENSHELL_IMAGE); no desktop base"; }
backend_has_base() { return 1; }
backend_exists() { os_call exists "$1"; }
backend_new() { os_call new "$@"; }
backend_list() { os_call list; }
# Logical endpoint: guest.mjs and __connect use the authenticated gateway relay, never DNS/TCP.
backend_ssh_endpoint() { os_call endpoint "$1"; }
backend_wait_endpoint() { backend_ssh_endpoint "$1"; }
backend_connect() { os_call connect "$1"; }
backend_platform_host_key() { os_call host-key "$1"; }
backend_start() { os_call start "$1"; }
backend_stop() { os_call stop "$1"; }
backend_rm() { os_call rm "$1"; }
backend_cleanup_new() { os_call cleanup "$1"; }
backend_images() { :; }
backend_capture() { die "OpenShell does not support disk snapshots, forks or pool resets"; }
backend_reimage() { die "OpenShell does not support disk restore"; }
backend_image_rm() { die "OpenShell does not support disk images"; }
backend_cleanup_image() { :; }
backend_recover_capture() { :; }
