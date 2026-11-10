export function registerStorageRoutes(app, db) {
  app.get("/api/storage", async () => {
    const rows = db
      .prepare(`
        SELECT
          CASE
            WHEN lower(path) LIKE '%.jpg'
              OR lower(path) LIKE '%.jpeg'
              OR lower(path) LIKE '%.png'
              OR lower(path) LIKE '%.gif'
              OR lower(path) LIKE '%.webp'
              OR lower(path) LIKE '%.bmp'
              THEN 'Images'

            WHEN lower(path) LIKE '%.mp4'
              OR lower(path) LIKE '%.mkv'
              OR lower(path) LIKE '%.avi'
              OR lower(path) LIKE '%.mov'
              OR lower(path) LIKE '%.webm'
              THEN 'Videos'

            WHEN lower(path) LIKE '%.mp3'
              OR lower(path) LIKE '%.wav'
              OR lower(path) LIKE '%.flac'
              OR lower(path) LIKE '%.aac'
              THEN 'Audio'

            WHEN lower(path) LIKE '%.pdf'
              OR lower(path) LIKE '%.doc'
              OR lower(path) LIKE '%.docx'
              OR lower(path) LIKE '%.txt'
              OR lower(path) LIKE '%.ppt'
              OR lower(path) LIKE '%.pptx'
              OR lower(path) LIKE '%.xls'
              OR lower(path) LIKE '%.xlsx'
              THEN 'Documents'

            WHEN lower(path) LIKE '%.zip'
              OR lower(path) LIKE '%.rar'
              OR lower(path) LIKE '%.7z'
              OR lower(path) LIKE '%.tar'
              OR lower(path) LIKE '%.gz'
              THEN 'Archives'

            WHEN lower(path) LIKE '%.exe'
              OR lower(path) LIKE '%.msi'
              THEN 'Applications'

            ELSE 'Other'
          END AS category,
          SUM(size) AS size
        FROM items
        WHERE type = 'file'
        GROUP BY category
        ORDER BY size DESC
      `)
      .all();

    return rows;
  });
}
