# Use official Python image
FROM python:3.11-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy all files
COPY . .

# Install Python dependencies
RUN pip install --no-cache-dir -r backend/requirements.txt

# Expose port
EXPOSE 8080

# Start the app
CMD ["python3", "backend/app.py"]
