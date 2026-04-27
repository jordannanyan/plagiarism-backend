-- Migration: tambah tabel check_target_dosen (junction)
-- Jalankan sekali di MySQL CLI / phpMyAdmin pada database plagiarism_db.
--
-- Tabel ini menghubungkan check_request -> dosen target.
-- Mahasiswa boleh memilih satu atau lebih dosen sebagai tujuan.
-- Backward-compat: check_request lama yang tidak punya entry di tabel ini
-- akan tetap terlihat oleh semua dosen (legacy).

CREATE TABLE IF NOT EXISTS check_target_dosen (
  id_check INT NOT NULL,
  id_dosen INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_check, id_dosen),
  CONSTRAINT fk_ctd_check
    FOREIGN KEY (id_check) REFERENCES check_request(id_check) ON DELETE CASCADE,
  CONSTRAINT fk_ctd_dosen
    FOREIGN KEY (id_dosen) REFERENCES dosen(id_dosen) ON DELETE CASCADE,
  KEY idx_ctd_dosen (id_dosen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
