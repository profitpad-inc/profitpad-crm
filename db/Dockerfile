# Database setup image (ghcr.io/profitpad-inc/profitpad-crm-migrate): the
# bootstrap, the migrations and a few admin commands, run against the db
# service over the network. docker-compose starts it on every "up"; it applies
# whatever is new and exits, and the API waits for it. See entrypoint.sh.
# Same major version as the db service, so psql matches the server.
FROM postgres:15
COPY migrate.sh entrypoint.sh /pcrm-db/
COPY bootstrap /pcrm-db/bootstrap
COPY migrations /pcrm-db/migrations
RUN chmod 755 /pcrm-db/migrate.sh /pcrm-db/entrypoint.sh
USER postgres
ENTRYPOINT ["/pcrm-db/entrypoint.sh"]
CMD ["migrate"]
