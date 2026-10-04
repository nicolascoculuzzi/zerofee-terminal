# Provisioning the Hetzner host

One Hetzner Cloud **CCX33** in **Falkenstein (FSN1)** runs everything at 100 users: 8 dedicated vCPU, 32 GB RAM, x86. Falkenstein measures about 1.2 ms to Frankfurt, where much of Solana's stake and every relay sits ([SPEC](../../SPEC.md#stack-cheapest-viable)). After this page, continue with [docs/ops/DEPLOY.md](../../docs/ops/DEPLOY.md).

Why this server type:

- **x86, not Arm.** The Yellowstone gRPC client ships native bindings for linux-x64 only, and the server imports it at start-up, so Hetzner's Arm servers (CAX) can't run the image.
- **Dedicated vCPU.** Ingest, the gateway and trade landing are latency-sensitive, and shared vCPUs (CPX) are noisy.

[`cloud-init.yaml`](cloud-init.yaml) hardens the box on first boot. It creates a `deploy` user that logs in with SSH keys only, disables root login, and sets up UFW (22/80/443), fail2ban, unattended security upgrades, Docker CE from Docker's own repository, chrony, a 4 GB swap file, log rotation and the `/opt/zerofee` layout.

## 1. SSH key

Use a hardware key if you have one (YubiKey or any FIDO2 key):

```bash
ssh-keygen -t ed25519-sk -C zerofee-deploy -f ~/.ssh/zerofee_deploy
```

Without one:

```bash
ssh-keygen -t ed25519 -C zerofee-deploy -f ~/.ssh/zerofee_deploy
```

This key is the root of trust for the server. `deploy` has passwordless sudo and is in the docker group, so whoever holds the key controls the host. Give it a passphrase and never copy it to another machine.

## 2. Render the cloud-init file with your key

```bash
KEY="$(cat ~/.ssh/zerofee_deploy.pub)"
sed "s|REPLACE_WITH_YOUR_SSH_PUBLIC_KEY|$KEY|" deploy/hetzner/cloud-init.yaml > /tmp/zerofee-cloud-init.yaml
grep -c REPLACE_WITH /tmp/zerofee-cloud-init.yaml
```

The last command must print `0`. Root login is disabled, so a wrong key means rebuilding the server (or the rescue route at the end of this page).

## 3. Cloud Firewall

Hetzner's Cloud Firewall is free and filters traffic before it reaches the server: a second layer behind UFW. It also covers the one gap UFW has, since ports that Docker publishes bypass UFW (this stack only publishes on 127.0.0.1, but defense in depth is cheap).

In the Hetzner Console: **Firewalls → Create Firewall**, name `zerofee-web`:

| Direction | Protocol | Port | Source |
|---|---|---|---|
| Inbound | TCP | 22 | your home or office IPs if they're stable, otherwise any |
| Inbound | TCP | 80 | any (ACME challenges, redirect to HTTPS) |
| Inbound | TCP | 443 | any |
| Inbound | UDP | 443 | any (HTTP/3) |
| Inbound | ICMP | | any |

Outbound: leave it open. The server streams from Chainstack, sends to Helius and Jito, and pulls images.

## 4. Create the server

Console: **Servers → Add Server**

| Setting | Value |
|---|---|
| Location | Falkenstein (FSN1) |
| Image | Ubuntu 24.04 |
| Type | Dedicated vCPU → **CCX33** (x86) |
| Networking | Public IPv4 and IPv6 |
| SSH keys | add `~/.ssh/zerofee_deploy.pub` (Hetzner then sends no root password) |
| Firewalls | `zerofee-web` |
| Backups | off: the stack ships its own encrypted off-site backups (Hetzner's add 20 % to the server price) |
| Cloud config | paste the contents of `/tmp/zerofee-cloud-init.yaml` |
| Name | `zerofee-1` |

The same with the [hcloud CLI](https://github.com/hetznercloud/cli), after `hcloud context create zerofee`:

```bash
hcloud ssh-key create --name zerofee-deploy --public-key-from-file ~/.ssh/zerofee_deploy.pub
hcloud server create --name zerofee-1 --type ccx33 --image ubuntu-24.04 --location fsn1 \
  --ssh-key zerofee-deploy --firewall zerofee-web --user-data-from-file /tmp/zerofee-cloud-init.yaml
```

Note the IPv4 and IPv6 addresses. Set reverse DNS (PTR) for both to your app domain under **Networking** if you like; it's optional.

## 5. Wait for cloud-init and verify

First boot takes a few minutes and may reboot once at the end (kernel upgrade). Then:

```bash
ssh -i ~/.ssh/zerofee_deploy deploy@<server-ip>
```

```bash
sudo cloud-init status --long
```

That should say `status: done`. Check each piece:

```bash
sudo ufw status verbose
```

Expect `22/tcp LIMIT`, `80/tcp`, `443/tcp`, `443/udp` and `Default: deny (incoming)`.

```bash
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|allowusers|authenticationmethods) '
```

Expect `permitrootlogin no`, `passwordauthentication no`, `allowusers deploy`, `authenticationmethods publickey`.

```bash
sudo fail2ban-client status sshd
docker version --format '{{.Server.Version}}' && docker compose version
cat /etc/docker/daemon.json
sudo iptables -S DOCKER-USER | grep 169.254.169.254
chronyc sources
swapon --show
ls -ld /opt/zerofee /opt/zerofee/*
```

`ls` should show `web` and `flags` with `drwxr-xr-x` and `backups` with `drwx------`, all owned by `deploy`. From your laptop, root must be refused:

```bash
ssh root@<server-ip>
```

## 6. Clone the repository and install the timers

If the repository is private, give the server a read-only deploy key:

```bash
ssh-keygen -t ed25519 -N '' -C zerofee-1-repo -f ~/.ssh/zerofee_repo
cat ~/.ssh/zerofee_repo.pub
```

Add that public key under the repository's **Settings → Deploy keys**, with write access off. Then:

```bash
GIT_SSH_COMMAND='ssh -i ~/.ssh/zerofee_repo' git clone git@github.com:<owner>/zerofee-terminal.git /opt/zerofee/app
git -C /opt/zerofee/app config core.sshCommand 'ssh -i ~/.ssh/zerofee_repo'
```

Install the nightly backup and per-minute health ping timers:

```bash
sudo /opt/zerofee/app/deploy/hetzner/install-units.sh
```

Next: [docs/ops/DEPLOY.md](../../docs/ops/DEPLOY.md), step 4.

## If you are locked out

Hetzner Console → the server → **Rescue** → enable the rescue system with your SSH key → **Power → Reset**. SSH in as root to the rescue system and run `mount /dev/sda1 /mnt`. Fix `/mnt/home/deploy/.ssh/authorized_keys` or `/mnt/etc/ssh/sshd_config.d/10-zerofee.conf`, unmount, and reboot.
