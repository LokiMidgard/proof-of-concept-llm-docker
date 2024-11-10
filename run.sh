#!/bin/bash

# Function to list available models with numbering, skipping the header and sorting alphabetically
list_models() {
  docker compose exec -it ollama ollama list | tail -n +2 | sort | awk '{print NR ") " $1}'
}

docker compose start ollama

# Check if a model name is provided
if [ -z "$1" ]; then
  echo "No model name provided. Listing available models:"
  models_list=$(list_models)
  echo "$models_list"

  echo "Please enter the number of the model you want to use:"
  read model_number

  # Get the model name based on the user's selection
  MODEL_NAME=$(echo "$models_list" | awk 'NR=='"$model_number"'{print $2}')

  if [ -z "$MODEL_NAME" ]; then
    echo "Invalid selection. Exiting."
    exit 1
  fi
else
  MODEL_NAME=$1
fi

docker compose exec -it ollama ollama run $MODEL_NAME
