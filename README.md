# Жевчик

Telegram-бот для групповых чатов: карма за пользу, антиспам для новичков, Mini App с лидербордом. Сообщения оценивает модель Jev от TypeSafe (версия `jev-1.13.0` закреплена).

[English version below](#english)

## Что умеет

- **Карма.** Участники получают карму за реакции других людей, ответы, цитаты, диалоги и благодарности, а также за полезные сообщения по оценке Jev. 👎 снимает карму. Накрутку гасят логарифмы и дневные лимиты.
- **Тег с кармой.** Рядом с именем участника в чате видна его карма числом, например `+321`. Админам и владельцу чата Telegram тег ставить не даёт; тег, поставленный человеком вручную, бот не трогает.
- **Mini App.** Лидерборд за неделю, месяц и всё время; личная страница участника с цифрами, графиком и лучшими сообщениями (её можно скрыть); баня с замаскированными именами спамеров.
- **Антиспам для новичков.** Первые пять сообщений участника в чате проверяются на спам. Явный спам удаляется сам, автор попадает в «парилку» (не может писать), в чат уходит шуточная реплика. Через сутки парилка превращается в бан.
- **Разбан через Mini App.** Под репликой кнопка «Я не спамер»: человек пишет короткое объяснение, Jev его оценивает. Попытка одна.
- **Команды.** `/spam` - админ отвечает этой командой на сообщение, бот удаляет его и отправляет автора в парилку. `/report` - любой участник жалуется на сообщение, админы получают карточку.
- **Карточки админам.** В личные сообщения: цитата, ссылка на сообщение, категория, уверенность и кнопки «Спам», «Не спам», «Не спам, вернуть», «Забанить». После нажатия бот пишет итог и правит карточку у всех админов.
- **Наказания за низкую карму.** Запрет ссылок и медиа, мьют на сутки, мьют на неделю.
- **Недельная сводка** в чате: лидеры недели, лучший ответ, число отправленных в баню.
- **Импорт истории.** Загрузка экспорта чата из Telegram Desktop даёт участникам стартовую карму за последние 90 суток.

## Что понадобится

- Сервер с Docker и Docker Compose. Образ по умолчанию собирается под `linux/arm64` (см. раздел «Процессор сервера»).
- Домен с HTTPS для Mini App. Telegram открывает Mini App только по HTTPS.
- Токен бота от [@BotFather](https://t.me/BotFather).
- Ключ TypeSafe API для модели Jev.
- Необязательно: ключ любой модели с OpenAI-совместимым API, которая понимает картинки. Она описывает фото, стикеры и гифки для Jev. Без неё медиа не описывается, остальное работает.

Бот получает обновления от Telegram сам (long polling), входящий вебхук не нужен. HTTPS нужен только веб-части с Mini App.

## Установка

1. **Создайте бота.** В @BotFather отправьте `/newbot`, задайте имя и username, сохраните токен.
2. **Выключите privacy mode.** В @BotFather: `/setprivacy`, выберите бота, `Disable`. Так бот видит все сообщения в группе.
3. **Скачайте проект на сервер.**
   ```
   git clone https://github.com/smixs/jevchik.git
   cd jevchik
   ```
4. **Заполните `.env`.** Скопируйте шаблон: `cp .env.example .env` и впишите значения:

   | Переменная | Обязательна | Что это |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | да | токен бота от BotFather |
   | `TYPESAFE_API_KEY` | да | ключ TypeSafe API для модели Jev |
   | `POSTGRES_PASSWORD` | да | пароль базы данных; придумайте длинный случайный |
   | `POSTGRES_USER` | нет | имя пользователя базы, по умолчанию `jevchik` |
   | `POSTGRES_DB` | нет | имя базы, по умолчанию `jevchik` |
   | `VISION_BASE_URL` | нет | адрес OpenAI-совместимого API модели описания картинок, например `https://api.example.com/v1`; бот обращается к `<адрес>/chat/completions` |
   | `VISION_MODEL` | нет | имя модели описания картинок у этого провайдера |
   | `VISION_API_KEY` | нет | ключ этого провайдера; описание картинок включается, только если заданы все три `VISION_*` |
   | `BOT_USERNAME` | нет | username бота без `@`; веб-часть берёт его для ссылок, если пусто - спрашивает у Telegram |
   | `WEB_PORT` | нет | порт на `127.0.0.1` сервера, где слушает веб-часть, по умолчанию `8080` |
   | `TELEGRAM_API_ROOT` | нет | адрес своего сервера Bot API; обычно пусто |
   | `JEV_API_URL` | нет | другой адрес API Jev; обычно пусто |

   Путь для файлов импорта (`IMPORT_DIR`) задан в `docker-compose.yml`, его менять не нужно.
5. **Запустите.**
   ```
   docker compose up -d --build --wait
   ```
   Поднимутся три контейнера: `db` (PostgreSQL 16), `bot` (получает сообщения и выполняет работу), `web` (Mini App и API). Таблицы базы создаются при первом запуске.
6. **Проверьте, что всё живо.**
   ```
   curl -s http://127.0.0.1:8080/healthz
   ```
   Ответ `{"status":"ok","db":"ok"}` значит, что веб-часть работает и видит базу. Если меняли `WEB_PORT`, подставьте свой порт.
7. **Поставьте HTTPS перед веб-портом.** Веб-часть слушает только `127.0.0.1` по HTTP. Пример для Caddy, установленного на этом же сервере (`/etc/caddy/Caddyfile`):
   ```
   bot.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
   Замените `bot.example.com` на свой домен, направьте его DNS на сервер и перезапустите Caddy. Caddy сам получит сертификат. Откройте `https://bot.example.com/healthz` в браузере - должен прийти тот же ответ.
8. **Включите Mini App у бота.** В @BotFather откройте настройки бота (`/mybots`, бот, `Bot Settings`, `Configure Mini App`), включите Main Mini App и укажите адрес сайта, например `https://bot.example.com/`.
9. **Добавьте бота в группу админом** с правами:
   - удалять сообщения;
   - блокировать участников;
   - менять теги участников.

   Бот должен быть админом, иначе Telegram не присылает ему реакции.
10. **Нажмите Start у бота.** Каждый админ группы, который хочет получать карточки, открывает личный чат с ботом и нажимает Start. Карточки, которые некому доставить, видны на экране админа в Mini App.

После подключения чат первую неделю находится в режиме наблюдения (подробнее ниже).

### Процессор сервера

Платформа `linux/arm64` зашита в двух файлах. На сервере с процессором amd64 (x86-64) замените `linux/arm64` на `linux/amd64`:

- в `Dockerfile` - в двух строках `FROM --platform=linux/arm64 node:22-alpine`;
- в `docker-compose.yml` - в трёх местах: список `platforms` в блоке `build`, строка `platform` в общем блоке `x-app` и строка `platform` у сервиса `db`.

Без этой правки Docker на amd64 попытается собрать и запустить arm64-образы, что работает только через эмуляцию. Тест `tests/deploy.test.ts` проверяет, что платформа - `linux/arm64`; после правки он упадёт, и его нужно поправить так же.

## Как это работает

### Откуда берётся карма

- Реакция другого участника на ваше сообщение даёт плюс, 👎 - минус. Реакции 💩 🤮 🤡 не учитываются. Списки меняются в настройках.
- Ответ на ваше сообщение, цитата, продолжение разговора и благодарность словами стоят дороже реакции. На одну пару сообщений засчитывается только самый дорогой сигнал.
- Jev оценивает пользу каждого сообщения по шкале от 0 до 4 и добавляет небольшую надбавку; при настройках по умолчанию она меньше одной человеческой реакции.
- Чем больше реакций под одним сообщением и чем чаще один человек плюсует другого, тем меньше стоит каждая следующая. Голос участника с большой кармой весит больше.
- Минусовать могут только участники с кармой не ниже 1, не больше 5 раз в сутки.
- Серия активных недель подряд даёт надбавку до +25%. Если человек молчит, то после 14 суток тишины каждые полные 30 суток его карма уменьшается на 10%.

### Что считается спамом

Jev отвечает на четыре вопроса: зовёт ли сообщение заработать или вложиться в крипту; использует ли разговор как повод для рекламы; заманивает ли в канал, группу или бота; является ли просто рекламой. Сообщение оценивается в контексте: на что оно отвечает, предыдущие реплики, сколько автор уже пишет в чате. Для первого сообщения Jev также смотрит профиль (имя, ник, описание) на рекламу.

Спам по тексту судится только у новичка - участника, у которого в чате не больше 5 сообщений. Участник с историей по тексту не наказывается. Сообщения от имени канала, автопересылки из привязанного канала и служебные сообщения не судятся.

### Что происходит со спамером

1. Новичок пишет сообщение, Jev оценивает его как спам с уверенностью от 90%.
2. Бот удаляет сообщение и запрещает автору писать («парилка»).
3. В чат уходит шуточная реплика с кнопкой «Я не спамер».
4. Автор появляется в бане в Mini App под замаскированным именем.
5. Админы получают карточку «Удалил спам и заглушил автора».
6. Автор может один раз нажать кнопку и объяснить, кто он. Jev оценивает объяснение: ограничение снимается, или отказ, или решение передаётся админам.
7. После разбана следующие 5 сообщений проверяются строже, ссылки в них удаляются.
8. Если за сутки разбана не было, парилка превращается в бан.

Если уверенность от 30% до 90%, сообщение остаётся, а админы получают карточку «Похоже на спам, реши». Безобидное первое сообщение новичка с рекламным профилем обрабатывается как явный спам. Админов и владельца чата бот не наказывает. Участника с кармой от 100 бот тоже не наказывает сам, а зовёт админа.

### Что видит админ

- Карточки в личных сообщениях: что сделал бот, участник, категория, уверенность в процентах, цитата сообщения, ссылка и кнопки решения. Карточки приходят и по жалобам `/report`, и при сбоях (например, если у бота нет прав).
- После нажатия кнопки - всплывающий ответ с итогом и строка «Решение: ...» с именем админа и временем в карточке у всех админов.
- Экран админа в Mini App (вкладка «Админ» видна только админам чата): настройки, журнал изменений настроек, загрузка истории, продление режима наблюдения, операции с ошибками, убранные сообщения за последние 30 суток, все карточки.

### Режим наблюдения

Первые 7 суток после подключения бота к чату наказания за низкую карму не применяются (то, что было бы применено, видно на экране админа), бот не ставит реакции на полезные сообщения и не шлёт недельную сводку. Антиспам, `/spam`, `/report`, кнопки карточек и теги работают с первого дня. Режим можно продлить на экране админа; отключить досрочно нельзя.

### Mini App

Mini App открывается кнопкой под репликой о спаме или под недельной сводкой, а также кнопкой Mini App в профиле бота. Во втором случае Mini App показывает список чатов, где участвует человек; если чат один, открывает его сразу. Вкладка «Разбан» видна только тому, кто в бане.

## Импорт истории

Бот видит только сообщения, пришедшие после его добавления. Чтобы участники сразу получили карму за прошлые сообщения:

1. В Telegram Desktop откройте группу, меню, «Экспорт истории чата». Формат - JSON. Фото и файлы выгружать не нужно, импорт их не читает.
2. В Mini App откройте вкладку «Админ», раздел «Импорт истории», выберите файл `result.json` и нажмите «Загрузить файл».
3. Состояние импорта видно в том же разделе.

Правила:
- берутся сообщения за последние 90 суток от момента загрузки (настройка `import_days`, от 1 до 366);
- файл не больше 50 МБ;
- номер чата в файле должен совпадать с чатом, где открыт экран админа; это защита от ошибки, а не доказательство подлинности файла;
- начисляются только плюсы, наказаний и банов по истории нет;
- повторная загрузка того же файла карму не удваивает;
- в чате одновременно идёт один импорт; незавершённый за 24 часа импорт прекращается;
- файл удаляется после подсчёта и при любой ошибке.

## Настройки

Настройки свои у каждого чата и меняются на экране админа без перезапуска. Каждая настройка - поле с именем ключа; списки и вопросы вводятся в формате JSON. Каждое изменение записывается в журнал. Новое значение действует на события после изменения, прошлую карму не пересчитывает. Полный список ключей с пределами - `src/settings/schema.json`.

Главные ключи:

| Ключ | По умолчанию | Что меняет |
|---|---|---|
| `spam_auto_threshold` | 0.9 | уверенность в спаме, с которой бот сам удаляет сообщение новичка и отправляет автора в парилку |
| `spam_review_threshold` | 0.3 | уверенность, с которой админы получают карточку «Похоже на спам, реши» |
| `profile_auto_threshold` | 0.8 | уверенность в рекламном профиле, с которой первое сообщение новичка обрабатывается как спам |
| `spam_newcomer_messages` | 5 | сколько сообщений участник считается новичком; 0 - проверять всех |
| `spam_review_delete_threshold` | 0.5 | на решения не влияет; должен быть не меньше `spam_review_threshold` и не больше `spam_auto_threshold` |
| `protect_threshold` | 100 | карма, с которой бот не наказывает участника сам, а жалоба участника сразу убирает сообщение |
| `steam_hours` | 24 | сколько часов длится парилка до бана |
| `probation_messages`, `probation_review_delete_threshold` | 5, 0.3 | испытательный срок после разбана: сколько сообщений и с какой уверенности сообщение удаляется |
| `appeal_accept`, `appeal_reject` | 0.7, 0.3 | оценка объяснения при разбане: от первого - разбан, ниже второго - отказ, между - решают админы |
| `reactions_minus`, `reactions_ignore` | `["👎"]`, `["💩","🤮","🤡"]` | минусующие и игнорируемые реакции; все остальные плюсуют |
| `base_reaction`, `base_reply`, `base_quote`, `base_dialog`, `base_thanks`, `base_minus` | 1, 2, 3, 4, 6, -1 | вес реакции, ответа, цитаты, диалога, благодарности и минуса |
| `usefulness_points` | `[0,0,0.1,0.25,0.5]` | надбавка за пользу по оценке Jev для уровней 0-4 |
| `minus_daily_limit`, `minus_min_karma` | 5, 1 | сколько минусов в сутки можно поставить и с какой кармы |
| `report_daily_limit`, `report_author_delta`, `report_reporter_delta` | 10, -20, 5 | лимит жалоб в сутки; сколько теряет автор и получает заявитель при подтверждённой жалобе |
| `punish_media_karma`, `punish_mute_day_karma`, `punish_mute_week_karma` | -10, -25, -40 | пороги наказаний: запрет ссылок и медиа, мьют на сутки, мьют на неделю |
| `karma_lower_bound` | -50 | ниже этой кармы не бывает |
| `silence_days`, `decay_period_days`, `decay_rate` | 14, 30, 0.1 | через сколько дней молчания карма начинает убывать, как часто и на какую долю |
| `streak_bonus_per_week`, `streak_bonus_max` | 0.05, 0.25 | надбавка за каждую неделю серии и её предел |
| `react_min_level`, `react_min_confidence`, `bot_reaction_emoji` | 4, 0.7, 🔥 | когда и какой реакцией бот отмечает полезное сообщение |
| `digest_enabled`, `digest_hour` | true, 10 | включена ли недельная сводка и с какого часа по времени чата она уходит |
| `timezone` | `Asia/Tashkent` | часовой пояс чата: недели, сводка, время в карточках |
| `observation_until` | пусто | до какого момента продлён режим наблюдения |
| `import_days` | 90 | окно импорта истории в сутках |
| `karma_tag_enabled`, `karma_tag_template`, `karma_tag_min_interval_minutes` | true, `{n}`, 10 | тег с кармой: включён ли, шаблон (`{n}` - карма со знаком, без эмодзи) и как часто обновляется |
| `held_text_days` | 30 | сколько суток админам доступен текст убранных сообщений (не больше 30) |
| `previous_messages_count` | 8 | сколько предыдущих реплик видит Jev |
| `questions` | из `eval/questions.json` | вопросы к Jev |

Вопрос для разбана `appeal_genuine` по умолчанию рассчитан на чат об ИИ и разработке. Для чата на другую тему поправьте его текст в настройке `questions`.

## Предупреждение о лексике

Шуточные реплики бота при удалении спама и объяснения в бане содержат мат. Они лежат в `data-static/jokes.json`. Чтобы заменить их, отредактируйте этот файл, сохранив формат:

- `replies` - список реплик в чат; `{name}` заменяется именем спамера;
- `explanations` - список шуточных объяснений для бани;
- `images` - список картинок для бани из `data-static/ban`.

Файл входит в образ, поэтому после правки пересоберите его: `docker compose up -d --build --wait`.

## Разработка

Нужны Node.js 22 или новее и PostgreSQL 16 (программы `initdb` и `pg_ctl`).

```
npm ci
npm test              # собирает проект и запускает тесты
npm run typecheck
npm run lint
npm run build         # сборка в dist/
npm run budget        # после build: размер Mini App не больше 150 КиБ в Brotli
```

Тесты идут на настоящем PostgreSQL: `npm test` сам поднимает временный кластер в `.scratch/pg` и удаляет его после прогона. Программы `initdb` и `pg_ctl` ищутся в каталоге из переменной `PG_BIN` (по умолчанию `/opt/homebrew/bin`). Вместо временного кластера можно указать работающий сервер в `TEST_DATABASE_URL`. Telegram, Jev и модель описания в тестах заменены двойниками, к внешним сервисам тесты не обращаются.

## Документы

- `DESIGN.md` - что делает бот и почему он так устроен.
- `docs/spec.md` - контракты, значения по умолчанию, таблица отказов и то, чем проверяется каждая гарантия.

## Лицензия

MIT, см. `LICENSE`.

---

<a id="english"></a>

## English

# Jevchik

A Telegram bot for group chats: karma for being useful, anti-spam for newcomers, a Mini App with a leaderboard. Messages are judged by the Jev model from TypeSafe (version `jev-1.13.0` is pinned).

The bot's own texts (cards, replies, Mini App) are in Russian.

## What it does

- **Karma.** Members earn karma from other people's reactions, replies, quotes, dialogs and thanks, and from useful messages as judged by Jev. 👎 takes karma away. Logarithms and daily limits damp vote farming.
- **Karma tag.** A member's karma is shown as a number next to their name in the chat, for example `+321`. Telegram does not let bots tag admins and the chat owner; a tag a person set by hand is left alone.
- **Mini App.** Leaderboard for the week, the month and all time; a personal page with numbers, a chart and the best messages (it can be hidden); the "bathhouse" with masked names of spammers.
- **Anti-spam for newcomers.** A member's first five messages are checked for spam. Clear spam is deleted automatically, the author goes to the "steam room" (cannot write), and a joke reply is posted to the chat. After a day the steam room turns into a ban.
- **Unban through the Mini App.** The joke reply has a button «Я не спамер» ("I am not a spammer"): the person writes a short explanation and Jev judges it. One attempt.
- **Commands.** `/spam` - an admin replies to a message with it; the bot deletes the message and sends its author to the steam room. `/report` - any member reports a message; admins get a card.
- **Admin cards.** In private messages: a quote, a link to the message, the category, the confidence and the buttons «Спам», «Не спам», «Не спам, вернуть», «Забанить» (spam, not spam, not spam and restore, ban). After a press the bot reports the result and edits the card for every admin.
- **Low-karma punishments.** No links and media, a one-day mute, a one-week mute.
- **Weekly digest** in the chat: leaders of the week, the best answer, how many were sent to the bathhouse.
- **History import.** Uploading a chat export from Telegram Desktop gives members starting karma for the last 90 days.

## What you need

- A server with Docker and Docker Compose. By default the image is built for `linux/arm64` (see "Server CPU").
- A domain with HTTPS for the Mini App. Telegram opens Mini Apps over HTTPS only.
- A bot token from [@BotFather](https://t.me/BotFather).
- A TypeSafe API key for the Jev model.
- Optional: a key for any vision model with an OpenAI-compatible API. It describes photos, stickers and GIFs for Jev. Without it media is not described; everything else works.

The bot fetches updates from Telegram itself (long polling); no incoming webhook is needed. HTTPS is only needed for the web part with the Mini App.

## Installation

1. **Create the bot.** In @BotFather send `/newbot`, set a name and a username, keep the token.
2. **Turn privacy mode off.** In @BotFather: `/setprivacy`, pick the bot, `Disable`. This lets the bot see every message in the group.
3. **Get the project onto the server.**
   ```
   git clone https://github.com/smixs/jevchik.git
   cd jevchik
   ```
4. **Fill in `.env`.** Copy the template with `cp .env.example .env` and set the values:

   | Variable | Required | What it is |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | yes | the bot token from BotFather |
   | `TYPESAFE_API_KEY` | yes | the TypeSafe API key for Jev |
   | `POSTGRES_PASSWORD` | yes | the database password; make it long and random |
   | `POSTGRES_USER` | no | database user, `jevchik` by default |
   | `POSTGRES_DB` | no | database name, `jevchik` by default |
   | `VISION_BASE_URL` | no | base URL of the OpenAI-compatible API of the vision model, for example `https://api.example.com/v1`; the bot calls `<url>/chat/completions` |
   | `VISION_MODEL` | no | the vision model name at that provider |
   | `VISION_API_KEY` | no | the key for that provider; image description is on only when all three `VISION_*` are set |
   | `BOT_USERNAME` | no | the bot username without `@`; the web part uses it for links and asks Telegram when it is empty |
   | `WEB_PORT` | no | the port on the server's `127.0.0.1` where the web part listens, `8080` by default |
   | `TELEGRAM_API_ROOT` | no | URL of your own Bot API server; usually empty |
   | `JEV_API_URL` | no | another Jev API URL; usually empty |

   The import directory (`IMPORT_DIR`) is set in `docker-compose.yml` and needs no change.
5. **Start it.**
   ```
   docker compose up -d --build --wait
   ```
   Three containers come up: `db` (PostgreSQL 16), `bot` (receives messages and does the work), `web` (Mini App and API). Database tables are created on the first start.
6. **Check that it is alive.**
   ```
   curl -s http://127.0.0.1:8080/healthz
   ```
   `{"status":"ok","db":"ok"}` means the web part runs and sees the database. Use your port if you changed `WEB_PORT`.
7. **Put HTTPS in front of the web port.** The web part listens on `127.0.0.1` over plain HTTP. An example for Caddy installed on the same server (`/etc/caddy/Caddyfile`):
   ```
   bot.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
   Replace `bot.example.com` with your domain, point its DNS at the server and restart Caddy. Caddy gets the certificate itself. Open `https://bot.example.com/healthz` in a browser; you should see the same answer.
8. **Turn on the bot's Mini App.** In @BotFather open the bot settings (`/mybots`, the bot, `Bot Settings`, `Configure Mini App`), enable the Main Mini App and set the site URL, for example `https://bot.example.com/`.
9. **Add the bot to the group as an admin** with the rights to:
   - delete messages;
   - ban members;
   - edit member tags.

   The bot must be an admin, otherwise Telegram does not send it reactions.
10. **Press Start in the bot.** Every group admin who wants to get cards opens a private chat with the bot and presses Start. Cards that cannot be delivered are shown on the admin screen of the Mini App.

For the first week after joining, the chat is in observation mode (see below).

### Server CPU

The `linux/arm64` platform is hard-coded in two files. On an amd64 (x86-64) server replace `linux/arm64` with `linux/amd64`:

- in `Dockerfile` - in the two `FROM --platform=linux/arm64 node:22-alpine` lines;
- in `docker-compose.yml` - in three places: the `platforms` list of the `build` block, the `platform` line of the shared `x-app` block and the `platform` line of the `db` service.

Without this change Docker on amd64 will try to build and run arm64 images, which works only through emulation. The test `tests/deploy.test.ts` checks that the platform is `linux/arm64`; after the change it fails and needs the same edit.

## How it works

### Where karma comes from

- Another member's reaction to your message adds karma, 👎 takes it away. 💩 🤮 🤡 are ignored. The lists are settings.
- A reply to your message, a quote, a continued conversation and thanks in words are worth more than a reaction. Only the most valuable signal counts for one pair of messages.
- Jev rates the usefulness of every message from 0 to 4 and adds a small bonus; with the default settings it is below one human reaction.
- The more reactions under one message and the more often one person upvotes another, the less each next one is worth. A vote from a member with high karma weighs more.
- Only members with karma of at least 1 can downvote, at most 5 times a day.
- A streak of active weeks gives a bonus of up to +25%. When a member goes silent, after 14 quiet days every full 30 days take 10% of their karma.

### What counts as spam

Jev answers four questions: does the message invite people to earn money or invest in crypto; does it use the conversation as a pretext for an ad; does it lure people to a channel, group or bot; is it just an ad. The message is judged in context: what it replies to, the previous messages, how long the author has been writing in the chat. For the first message Jev also checks the profile (name, username, bio) for advertising.

Spam by text is judged only for a newcomer - a member with at most 5 messages in the chat. A member with a history is not punished by text. Messages sent on behalf of a channel, automatic forwards from the linked channel and service messages are not judged.

### What happens to a spammer

1. A newcomer writes a message, and Jev rates it as spam with a confidence of 90% or more.
2. The bot deletes the message and stops the author from writing (the "steam room").
3. A joke reply with the «Я не спамер» button goes to the chat.
4. The author appears in the bathhouse in the Mini App under a masked name.
5. Admins get the card «Удалил спам и заглушил автора» ("deleted spam and muted the author").
6. The author can press the button once and explain who they are. Jev judges the explanation: the restriction is lifted, or refused, or the decision goes to the admins.
7. After an unban the next 5 messages are checked more strictly, and links in them are deleted.
8. If there was no unban within a day, the steam room turns into a ban.

With a confidence from 30% to 90% the message stays and admins get the card «Похоже на спам, реши» ("looks like spam, decide"). A harmless first message from a newcomer with an advertising profile is handled like clear spam. The bot never punishes admins or the chat owner. It does not punish a member with karma of 100 or more on its own either; it calls an admin.

### What an admin sees

- Cards in private messages: what the bot did, the member, the category, the confidence in percent, a quote of the message, a link and decision buttons. Cards also come for `/report` and for failures (for example, when the bot lacks rights).
- After a button press: a popup with the result and a line «Решение: ...» with the admin's name and the time, on the card of every admin.
- The admin screen in the Mini App (the «Админ» tab is visible to chat admins only): settings, the settings change log, history upload, extending observation mode, failed operations, removed messages of the last 30 days, all cards.

### Observation mode

For the first 7 days after the bot joins a chat, low-karma punishments are not applied (what would have been applied is shown on the admin screen), the bot does not react to useful messages and does not send the weekly digest. Anti-spam, `/spam`, `/report`, card buttons and tags work from day one. The mode can be extended on the admin screen; it cannot be ended early.

### Mini App

The Mini App opens from the button under a spam joke reply or under the weekly digest, and from the Mini App button in the bot's profile. In the latter case it lists the chats the person takes part in; with a single chat it opens it at once. The «Разбан» (unban) tab is visible only to someone in the bathhouse.

## History import

The bot only sees messages that arrive after it was added. To give members karma for past messages:

1. In Telegram Desktop open the group, the menu, "Export chat history". Format: JSON. Photos and files are not needed; the import does not read them.
2. In the Mini App open the «Админ» tab, section «Импорт истории», pick `result.json` and press «Загрузить файл».
3. The import status is shown in the same section.

Rules:
- messages of the last 90 days before the upload are taken (setting `import_days`, 1 to 366);
- the file is at most 50 MB;
- the chat id in the file must match the chat whose admin screen is open; this guards against mistakes and does not prove the file is genuine;
- only positive karma is awarded; no punishments or bans come from history;
- uploading the same file again does not double karma;
- one import at a time per chat; an import not finished within 24 hours is stopped;
- the file is deleted after counting and on any error.

## Settings

Every chat has its own settings, changed on the admin screen without a restart. Each setting is a field named after its key; lists and questions are entered as JSON. Every change is logged. A new value applies to events after the change and does not recalculate past karma. The full list of keys with their limits is in `src/settings/schema.json`.

Main keys:

| Key | Default | What it changes |
|---|---|---|
| `spam_auto_threshold` | 0.9 | spam confidence at which the bot deletes a newcomer's message itself and sends the author to the steam room |
| `spam_review_threshold` | 0.3 | confidence at which admins get the "looks like spam, decide" card |
| `profile_auto_threshold` | 0.8 | advertising-profile confidence at which a newcomer's first message is handled as spam |
| `spam_newcomer_messages` | 5 | for how many messages a member counts as a newcomer; 0 checks everybody |
| `spam_review_delete_threshold` | 0.5 | does not affect decisions; must be at least `spam_review_threshold` and at most `spam_auto_threshold` |
| `protect_threshold` | 100 | karma from which the bot does not punish a member itself and the member's report removes a message at once |
| `steam_hours` | 24 | how many hours the steam room lasts before the ban |
| `probation_messages`, `probation_review_delete_threshold` | 5, 0.3 | probation after an unban: how many messages, and from which confidence a message is deleted |
| `appeal_accept`, `appeal_reject` | 0.7, 0.3 | unban explanation score: from the first - unban, below the second - refusal, in between - admins decide |
| `reactions_minus`, `reactions_ignore` | `["👎"]`, `["💩","🤮","🤡"]` | downvoting and ignored reactions; all others upvote |
| `base_reaction`, `base_reply`, `base_quote`, `base_dialog`, `base_thanks`, `base_minus` | 1, 2, 3, 4, 6, -1 | weight of a reaction, reply, quote, dialog, thanks and downvote |
| `usefulness_points` | `[0,0,0.1,0.25,0.5]` | bonus for usefulness as rated by Jev, levels 0-4 |
| `minus_daily_limit`, `minus_min_karma` | 5, 1 | how many downvotes a day and from which karma |
| `report_daily_limit`, `report_author_delta`, `report_reporter_delta` | 10, -20, 5 | reports per day; what the author loses and the reporter gains on a confirmed report |
| `punish_media_karma`, `punish_mute_day_karma`, `punish_mute_week_karma` | -10, -25, -40 | punishment thresholds: no links and media, one-day mute, one-week mute |
| `karma_lower_bound` | -50 | karma never goes below this |
| `silence_days`, `decay_period_days`, `decay_rate` | 14, 30, 0.1 | after how many silent days karma starts to decay, how often and by what share |
| `streak_bonus_per_week`, `streak_bonus_max` | 0.05, 0.25 | bonus per week of a streak and its cap |
| `react_min_level`, `react_min_confidence`, `bot_reaction_emoji` | 4, 0.7, 🔥 | when and with which reaction the bot marks a useful message |
| `digest_enabled`, `digest_hour` | true, 10 | whether the weekly digest is on and from which hour of chat time it is sent |
| `timezone` | `Asia/Tashkent` | the chat time zone: weeks, digest, times in cards |
| `observation_until` | empty | until when observation mode is extended |
| `import_days` | 90 | history import window in days |
| `karma_tag_enabled`, `karma_tag_template`, `karma_tag_min_interval_minutes` | true, `{n}`, 10 | karma tag: on or off, template (`{n}` is signed karma, no emoji) and how often it is updated |
| `held_text_days` | 30 | for how many days admins can read removed messages (at most 30) |
| `previous_messages_count` | 8 | how many previous messages Jev sees |
| `questions` | from `eval/questions.json` | the questions for Jev |

The unban question `appeal_genuine` assumes by default a chat about AI and software. For a chat on another topic, edit its text in the `questions` setting.

## Language warning

The bot's joke replies on spam deletion and the bathhouse explanations contain Russian profanity. They live in `data-static/jokes.json`. To replace them, edit that file and keep its format:

- `replies` - replies posted to the chat; `{name}` is replaced with the spammer's name;
- `explanations` - joke explanations for the bathhouse;
- `images` - bathhouse pictures from `data-static/ban`.

The file is part of the image, so rebuild after editing: `docker compose up -d --build --wait`.

## Development

You need Node.js 22 or newer and PostgreSQL 16 (the `initdb` and `pg_ctl` programs).

```
npm ci
npm test              # builds the project and runs the tests
npm run typecheck
npm run lint
npm run build         # builds into dist/
npm run budget        # after build: the Mini App is at most 150 KiB with Brotli
```

Tests run against a real PostgreSQL: `npm test` starts a throwaway cluster in `.scratch/pg` and removes it afterwards. `initdb` and `pg_ctl` are looked up in the directory from `PG_BIN` (`/opt/homebrew/bin` by default). Instead of the throwaway cluster you can point `TEST_DATABASE_URL` at a running server. Telegram, Jev and the vision model are replaced by test doubles; the tests call no external services.

## Documents

- `DESIGN.md` - what the bot does and why it is built this way (in Russian).
- `docs/spec.md` - contracts, defaults, the failure table and what verifies each guarantee (in Russian).

## License

MIT, see `LICENSE`.
