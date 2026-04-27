# Justifikasi Parameter Algoritma & Single-Active Params

Dokumen ini menjelaskan dasar pemilihan nilai parameter `k = 5`, `w = 4`,
`base = 101`, dan kebijakan hanya satu params aktif pada satu waktu.
Bisa Jordan kutip langsung di laporan/skripsi (BAB 3 - Metode atau BAB 4
- Implementasi).

---

## 1. Mengapa hanya satu Params yang aktif?

Sistem ini memakai algoritma **Winnowing** (Schleimer, Wilkerson, & Aiken,
2003) yang menghasilkan **fingerprint** dari setiap dokumen. Fingerprint
disimpan di tabel `fingerprint_user` / `fingerprint_corpus` dan dipakai
sebagai basis perbandingan similarity.

Fingerprint **terikat pada nilai k dan w yang dipakai saat ekstraksi**:
- Jika dokumen A di-fingerprint pakai (k=5, w=4) dan dokumen B
  di-fingerprint pakai (k=7, w=5), kedua fingerprint **tidak bisa
  dibandingkan** karena ruang hash dan posisi window-nya berbeda.
- Membandingkan dua fingerprint dengan parameter berbeda akan menghasilkan
  similarity yang **tidak valid secara matematis** (false negative tinggi).

Oleh karena itu pada satu waktu sistem **wajib** memakai **satu set
parameter yang konsisten** untuk semua proses check. Pada implementasi:

- Tabel `algoritma_params` menyimpan riwayat seluruh konfigurasi.
- Kolom `active_from` / `active_to` menandai mana yang aktif.
- Endpoint `PATCH /api/admin/params/:id/activate` otomatis menutup baris
  lain dengan `active_to = NOW()` sebelum mengaktifkan baris baru.

**Apakah multi-active mungkin?** Bisa, tapi konsekuensinya:
1. Setiap fingerprint harus diberi tag `params_id`, dan
2. Saat pengecekan, hanya fingerprint dengan `params_id` yang sama yang
   bisa dibandingkan, atau
3. Setiap dokumen harus di-fingerprint ulang berkali-kali untuk setiap
   set parameter — sangat boros storage dan waktu.

Untuk skripsi/aplikasi tunggal-instansi seperti ini, single-active adalah
**desain yang benar dan paling lazim** di literatur deteksi plagiarisme
berbasis fingerprint.

---

## 2. Mengapa k = 5 (n-gram)?

`k` adalah panjang n-gram (substring karakter) yang di-hash sebagai unit
dasar fingerprint. Pemilihan `k` adalah trade-off antara **noise** dan
**recall**.

| k yang terlalu kecil (k ≤ 3) | k yang terlalu besar (k ≥ 10) |
|---|---|
| Banyak match palsu — kata fungsi pendek ("the", "dan") akan ikut nge-match. | Sensitif sekali terhadap perubahan kecil — ganti satu kata sinonim merusak banyak n-gram. |
| Recall tinggi tapi precision rendah. | Recall rendah, terutama untuk parafrase. |
| Fingerprint membengkak. | Fingerprint sangat tipis, mudah miss plagiat ringan. |

Schleimer dkk. (2003, §4) merekomendasikan rentang `k = 4–8` untuk teks
alami. Pada implementasi praktis untuk **dokumen akademik berbahasa
Indonesia**, `k = 5` memberi:

- **Cukup spesifik**: "yang " (4 char + spasi) tidak otomatis jadi match.
- **Cukup pendek**: parafrase sederhana ("mahasiswa" → "siswa") masih
  meninggalkan banyak n-gram yang sama.
- **Konsisten dengan banyak implementasi** open-source (MOSS pakai
  k berkisar 5, JPlag menggunakan kategori serupa).

> **Rumusan untuk laporan**:
> Nilai k = 5 dipilih sebagai keseimbangan antara *noise robustness* dan
> *paraphrase sensitivity* (Schleimer dkk., 2003). Nilai di bawah 4
> menyebabkan match palsu pada kata-kata fungsi, sedangkan nilai di atas
> 8 menyebabkan algoritma gagal mendeteksi parafrase ringan.

---

## 3. Mengapa w = 4 (window)?

`w` adalah ukuran **sliding window** untuk algoritma Winnowing. Dari setiap
window berisi `w` hash, dipilih satu hash dengan nilai minimum sebagai
fingerprint (memilih hash terkanan jika ada tie).

Schleimer dkk. (2003) membuktikan **density theorem**:

```
density rata-rata fingerprint = 2 / (w + 1)
```

Artinya:

| w  | density (fraksi n-gram yang disimpan) |
|----|---------------------------------------|
| 2  | 0.667 (66.7%)                          |
| 4  | 0.40 (40%)                             |
| 8  | 0.222 (22.2%)                          |
| 16 | 0.118 (11.8%)                          |

Mereka juga menetapkan **noise threshold t** = panjang minimum match yang
dijamin terdeteksi. Hubungannya:

```
t ≥ k + w − 1   →   garansi semua substring sepanjang t pasti dideteksi
```

Dengan `k = 5` dan `w = 4`, `t = 5 + 4 − 1 = 8` karakter. Artinya semua
salinan literal sepanjang ≥ 8 karakter **pasti** terdeteksi. Untuk dokumen
akademik, kalimat plagiat biasanya jauh lebih panjang dari 8 karakter,
sehingga deteksi sangat reliabel.

Trade-off:

- **w lebih kecil** → density tinggi → fingerprint membengkak, lebih
  banyak storage dan komputasi, banyak match-noise.
- **w lebih besar** → density rendah → cepat dan ringan, tapi salinan
  pendek bisa lolos.

`w = 4` memberi density 40% yang **balance**: cukup hemat storage tapi
masih sensitif terhadap penyalinan literal sepanjang 1 kalimat pendek.

> **Rumusan untuk laporan**:
> Nilai w = 4 dipilih agar noise-threshold t = k + w − 1 = 8 karakter
> tetap kecil (semua salinan literal ≥ 8 karakter dijamin dideteksi)
> sementara density fingerprint tetap rendah, yaitu 2/(w+1) ≈ 40 %
> (Schleimer dkk., 2003).

---

## 4. Mengapa base = 101 (rolling hash)?

`base` adalah basis untuk **rolling hash (Rabin-Karp)** yang dipakai untuk
menghitung hash n-gram secara incremental.

Rumus rolling hash:
```
hash(s) = (s[0]·b^(k-1) + s[1]·b^(k-2) + ... + s[k-1]) mod M
```

Kriteria pemilihan `base`:

1. **Bilangan prima** — meminimalkan collision saat di-mod terhadap
   modulus M.
2. **Lebih besar dari ukuran alfabet** — agar setiap karakter punya
   "tempat" yang unik di basis. Karakter ASCII printable berkisar 32–126
   (94 simbol). Maka `base ≥ 95` aman.
3. **Tidak terlalu besar** — supaya `base^k` tidak overflow integer 32-bit
   sebelum di-modulo.

`101` memenuhi ketiganya: prima, > 94 (alfabet ASCII), dan cukup kecil
agar perhitungan tetap dalam range aman. Nilai ini adalah **pilihan
tradisional** dalam literatur algoritma string (CLRS — *Introduction to
Algorithms*, Bab 32 - String Matching).

Alternatif lain yang sah: 31, 37, 53, 131, 257. Semua memberikan distribusi
hash yang baik — yang penting prima dan > ukuran alfabet.

> **Rumusan untuk laporan**:
> Nilai base = 101 dipilih sebagai bilangan prima yang lebih besar dari
> jumlah karakter ASCII printable (94 simbol), sehingga distribusi hash
> Rabin-Karp seragam dan probabilitas collision rendah (Cormen dkk., 2009,
> Bab 32). Nilai ini cukup kecil untuk menghindari overflow saat
> menghitung base^k pada rolling hash.

---

## 5. Threshold = 0.30 (30%)

Tidak diminta tapi sekalian saya jelaskan, karena ibu mungkin tanya juga.

Threshold 30% mengacu pada konvensi umum aturan plagiarisme di banyak
universitas Indonesia (mengikuti rambu-rambu Permendiknas No. 17 Tahun
2010 dan implementasi Turnitin di banyak kampus, yang biasanya menandai
laporan dengan similarity ≥ 30 % sebagai *needs review*). Bukan angka
absolut — admin bisa menggantinya kapan saja lewat halaman Admin Params.

---

## Referensi (untuk daftar pustaka)

- Schleimer, S., Wilkerson, D. S., & Aiken, A. (2003). Winnowing: Local
  algorithms for document fingerprinting. *Proceedings of the 2003 ACM
  SIGMOD International Conference on Management of Data*, 76–85.
  https://doi.org/10.1145/872757.872770
- Cormen, T. H., Leiserson, C. E., Rivest, R. L., & Stein, C. (2009).
  *Introduction to Algorithms* (3rd ed.). MIT Press. (Bab 32 - String
  Matching, sub-bab Rabin-Karp).
- Karp, R. M., & Rabin, M. O. (1987). Efficient randomized
  pattern-matching algorithms. *IBM Journal of Research and Development*,
  31(2), 249–260.
