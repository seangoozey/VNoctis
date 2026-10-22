CREATE TABLE "ImportUpload" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "ownerId" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "size" BIGINT NOT NULL,
 "offset" BIGINT NOT NULL DEFAULT 0,
 "checksum" TEXT NOT NULL,
 "lastError" TEXT,
 "expiresAt" DATETIME NOT NULL,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "ImportUpload_id_fkey" FOREIGN KEY ("id") REFERENCES "WorkJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ImportUpload_ownerId_expiresAt_idx" ON "ImportUpload"("ownerId", "expiresAt");
