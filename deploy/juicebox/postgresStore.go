package records

import (
	"context"
	"errors"
	"os"

	"github.com/fxamacker/cbor/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/juicebox-systems/juicebox-software-realm/otel"
	"github.com/juicebox-systems/juicebox-software-realm/types"
)

// PostgresRecordStore keeps user records in one Postgres table, keyed by realm
// and record id. Writes are conditional on the version that was read, as with
// the other stores.
type PostgresRecordStore struct {
	pool  *pgxpool.Pool
	realm string
}

func NewPostgresRecordStore(ctx context.Context, realmID types.RealmID) (*PostgresRecordStore, error) {
	ctx, span := otel.StartSpan(ctx, "NewPostgresRecordStore")
	defer span.End()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil, otel.RecordOutcome(errors.New("unexpectedly missing DATABASE_URL"), span)
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, otel.RecordOutcome(err, span)
	}
	_, err = pool.Exec(ctx, `create table if not exists juicebox_records (
		realm text not null,
		id text not null,
		record bytea not null,
		version bigint not null,
		primary key (realm, id)
	)`)
	if err != nil {
		return nil, otel.RecordOutcome(err, span)
	}
	return &PostgresRecordStore{pool: pool, realm: realmID.String()}, nil
}

func (p PostgresRecordStore) GetRecord(ctx context.Context, recordID UserRecordID) (UserRecord, interface{}, error) {
	ctx, span := otel.StartSpan(ctx, "GetRecord")
	defer span.End()

	userRecord := DefaultUserRecord()
	var serialized []byte
	var version int64
	err := p.pool.QueryRow(ctx, `select record, version from juicebox_records where realm = $1 and id = $2`, p.realm, string(recordID)).Scan(&serialized, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return userRecord, nil, nil
	}
	if err != nil {
		return userRecord, nil, otel.RecordOutcome(err, span)
	}
	if err := cbor.Unmarshal(serialized, &userRecord); err != nil {
		return userRecord, version, otel.RecordOutcome(err, span)
	}
	return userRecord, version, nil
}

func (p PostgresRecordStore) WriteRecord(ctx context.Context, recordID UserRecordID, record UserRecord, readRecord interface{}) error {
	ctx, span := otel.StartSpan(ctx, "WriteRecord")
	defer span.End()

	serialized, err := cbor.Marshal(record)
	if err != nil {
		return otel.RecordOutcome(err, span)
	}

	var tag interface{ RowsAffected() int64 }
	if readRecord == nil {
		// nothing was stored when we read: only insert
		tag, err = p.pool.Exec(ctx, `insert into juicebox_records (realm, id, record, version) values ($1, $2, $3, 0) on conflict do nothing`,
			p.realm, string(recordID), serialized)
	} else {
		version, ok := readRecord.(int64)
		if !ok {
			return otel.RecordOutcome(errors.New("unexpected type for read record"), span)
		}
		tag, err = p.pool.Exec(ctx, `update juicebox_records set record = $3, version = version + 1 where realm = $1 and id = $2 and version = $4`,
			p.realm, string(recordID), serialized, version)
	}
	if err != nil {
		return otel.RecordOutcome(err, span)
	}
	if tag.RowsAffected() != 1 {
		return otel.RecordOutcome(errors.New("record changed since it was read"), span)
	}
	return nil
}
