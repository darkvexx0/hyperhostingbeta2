# HyperHosting

Node.js 20+ ve Discord.js v14 ile hazırlanmış, yerel `database.json` kullanan başlangıç projesi.

## Kurulum (Windows 11)

1. Node.js 20 veya üzerini kur.
2. Bu klasörü aç ve terminalde şunları çalıştır:

```bash
npm install
```

3. `.env.example` dosyasını `.env` olarak kopyala ve `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` alanlarını doldur.
4. Discord Developer Portal > Bot bölümünde **Server Members Intent** ve **Guild Invites** için gerekli intent/izinleri etkinleştir. Botun davetleri okuyabilmesi için sunucuda uygun izinleri olmalı.
5. Başlat:

```bash
npm start
```

6. Sunucunda `/panel` komutunu kullan.

## Neler var?

- Yerel `database.json` ve sıralı dosya yazma kuyruğu
- bcrypt ile panel şifresi hashleme
- Kayıt modalı, bot oluşturma modalı ve özel yönetim paneli
- Bot dosyası ekleme, listeleme, kod önizleme, düzenleme ve silme
- `child_process.spawn` ile bot süreci başlatma/durdurma
- Hesap yaşı 21 günden yeni olan davetleri geçersiz sayma
- Ayrılan üyenin davetini geçersiz sayma ve davet kotası düşünce botları durdurma
- Etkileşimlerde hata yakalama ve `deferReply`

## Önemli sınırlamalar ve üretim öncesi yapılacaklar

- **Bu sürüm güvenli, çok kiracılı bir hosting ortamı için hazır değildir.** `spawn` ayrı süreç açar ama güvenlik sınırı oluşturmaz. Müşteri kodu sunucu dosyalarına ve ağa erişebilir. Gerçek müşteriler için her botu ayrı, kısıtlı işletim sistemi kullanıcısı veya konteyner altında; CPU/RAM/disk sınırları, ağ politikaları ve zaman aşımıyla çalıştırın.
- Kod modalı Discord'un metin alanı sınırı nedeniyle tek seferde 4000 karakterle sınırlıdır. Büyük projeler için arşiv yükleme ve güvenli dosya taraması eklenmelidir.
- Davet kodu kullanımını, aynı anda birden fazla kişinin katıldığı veya vanity URL kullanıldığı durumlarda Discord API her zaman kesin biçimde eşleştirmeyebilir. Bu örnek sadece botun gözlemleyebildiği artışları kaydeder. Üretimde belirsiz davetleri ödüllendirmeyin ve manuel inceleme yolu sağlayın.
- Şifre belirleme bu başlangıç sürümünde hesabı kaydeder/şifreyi yeniler; `botaktif sifre botadi` sunucu eşleştirme komutu ayrıca eklenmelidir. Şifreleri mesaj/komut argümanlarında istemeyin; modal kullanın.
- `database.json` tek sunucu süreci için uygundur. Birden fazla HyperHosting ana süreci aynı dosyaya yazmamalıdır. Düzenli yedek alın.
- Müşteri bot tokenları bu örnekte toplanmaz veya saklanmaz. Müşteri botlarının `index.js` kodu kendi tokenını güvenli bir ortam değişkeninden almalıdır; tokenı Discord mesajına ya da kaynak koda koymayın.
- `GuildMembers` intent ve sunucu davetlerini görme izinleri gerekir. Davet sayısı yalnızca bot katıldıktan sonra gözlemlenen veriler üzerinden hesaplanabilir.
- Bot başına davet koşulu başlangıçta kontrol edilir. Davet sayısı minimumun altına düşünce ilgili sahibin çalışan botları durdurulur.
- `uncaughtException` yalnızca loglanır; gerçek dağıtımda PM2/systemd gibi bir süreç yöneticisi ve düzgün kapanış/yeniden başlatma stratejisi kullanın.

## Veri klasörü

```text
HyperHosting/
├─ src/index.js
├─ bots/
│  └─ <discord-user-id>/
│     └─ <bot-name-and-id>/
├─ database.json
├─ .env
├─ package.json
└─ README.md
```

`database.json` ilk çalıştırmada otomatik oluşturulur. Gerçek bot tokenlarını, `.env` dosyasını veya müşteri kodlarını herkese açık depoya yüklemeyin.


## GitHub'a yükleme notu

- `node_modules` klasörünü GitHub'a yükleme; depoyu açınca `npm install` komutuyla yeniden kurulur.
- Gerçek `.env` dosyanı yükleme; gizli token ve anahtarları burada tut.
- `database.json` yerel kullanıcı verilerini içerebilir, bu nedenle `.gitignore` içinde tutulur.
- `bots/` klasöründeki çalıştırılabilir müşteri botu dosyaları da varsayılan olarak yüklenmez.
- GitHub web arayüzünden yüklerken yalnızca bu projedeki kaynak dosyalarını yükle; tüm klasörü `node_modules` ile birlikte sürükleme.
