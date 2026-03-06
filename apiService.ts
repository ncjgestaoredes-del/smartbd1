
const API_BASE_URL = '/api';

/**
 * apiService centraliza todas as chamadas HTTP do frontend.
 * Conecta o frontend React ao servidor backend hospedado no Render.
 */
export const apiService = {
    getUrl(endpoint: string) {
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        return `${API_BASE_URL}${cleanEndpoint}`;
    },

    async get(endpoint: string) {
        try {
            const response = await fetch(this.getUrl(endpoint));
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.message || `Erro ${response.status} ao buscar dados.`);
            }
            return await response.json();
        } catch (error) {
            console.error(`Erro GET ${endpoint}:`, error);
            throw error;
        }
    },

    async post(endpoint: string, data: any) {
        try {
            const response = await fetch(this.getUrl(endpoint), {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(data)
            });
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.message || `Erro ${response.status} ao enviar dados.`);
            }
            return await response.json();
        } catch (error) {
            console.error(`Erro POST ${endpoint}:`, error);
            throw error;
        }
    },

    async delete(endpoint: string) {
        try {
            const response = await fetch(this.getUrl(endpoint), {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Erro ao remover dados');
            return await response.json();
        } catch (error) {
            console.error(`Erro DELETE ${endpoint}:`, error);
            throw error;
        }
    }
};
