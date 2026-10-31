# Migrating from agentvm

← [Docs](README.md)

boxery used to be called `agentvm`. Existing VMs keep working. They were created as libvirt domains `avm-NAME` in pool `agentvm`, and they carry `/opt/agentvm` and `agentvm-*` services inside. The renamed code accepts them through `host.env` compatibility keys.

On the host:

```bash
systemctl --user disable --now agentvm-proxy agentvm-vsock
mv ~/.config/agentvm ~/.config/boxery && mv ~/.agentvm ~/.boxery && mv ~/.cache/agentvm ~/.cache/boxery
cat >> ~/.config/boxery/host.env <<'EOF'
BOXERY_POOL=agentvm
BOXERY_POOL_DIR=/var/lib/libvirt/images/agentvm
BOXERY_BASE_VOL=agentvm-base.qcow2
BOXERY_DOMAIN_PREFIX=avm-
EOF
sed -i 's/AGENTVM_/BOXERY_/; s/agentvm-proxy/boxery-proxy/' ~/.config/boxery/host.env
boxery-host init
```

On each laptop:

```bash
boxery setup you@my-host      # new ssh_config (*.boxery hosts)
```

The LLM proxy still accepts tokens minted before the rename. To get fully renamed guests, remove the old VMs and rebuild the base image.
