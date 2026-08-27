# The backup image: pg_dump and an S3 client, nothing else.
#
# Built from the same Postgres image the database runs, so `pg_dump` matches the
# server exactly. A newer client can read an older server, an OLDER client
# cannot read a newer one — and a version mismatch surfaces as a refusal at
# backup time, which is the moment it is least welcome.
FROM postgres:16.14-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55

# Debian's awscli, rather than a second base image. `aws s3 cp` is the whole
# requirement and pulling the v2 installer would add a download and a
# self-updating binary to a container whose job is to be boring.
RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Never root: this container holds a credential that can read every row.
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
