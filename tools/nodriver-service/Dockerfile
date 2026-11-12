FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    CHROME_BIN=/usr/bin/chromium \
    BROWSER_HEADLESS=true \
    ALLOWED_DOMAINS=worten.pt

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app app.py renderer.py safe_proxy.py security.py ./
USER app

EXPOSE 8080
CMD ["python", "app.py"]
